/* global $, __webpack_public_path__ */
import View from '@girder/core/views/View';
import { restRequest, getApiRoot } from '@girder/core/rest';
import _ from 'underscore';

import router from '@girder/histomicsui/router';
import FolderCollection from '@girder/core/collections/FolderCollection';
import AnnotationModel from '@girder/large_image_annotation/models/AnnotationModel';
import ItemCollection from '@girder/core/collections/ItemCollection';
import JobStatus from '@girder/jobs/JobStatus.js';
import { parse } from '@girder/slicer_cli_web/parser';

import learningTemplate from '../../templates/body/activeLearningView.pug';
import ActiveLearningContainer from '../vue/components/ActiveLearning/ActiveLearningContainer.vue';
import ActiveLearningSetupContainer from '../vue/components/ActiveLearningSetup/ActiveLearningSetupContainer.vue';
import { store, assignHotkey } from '../vue/components/store.js';

import '../../stylesheets/body/learning.styl';

const yaml = require('js-yaml');

const activeLearningSteps = {
    SuperpixelSegmentation: 0,
    InitialLabeling: 1,
    GuidedLabeling: 2
};

const epochRegex = /epoch (\d+)/i;

const defaultAnnotationGroups = {
    replaceGroups: true,
    defaultGroup: 'default',
    groups: [
        {
            id: 'default',
            fillColor: 'rgba(0, 0, 0, 0)',
            lineColor: 'rgba(0, 0, 0, 1)',
            lineWidth: 2
        }
    ]
};

/**
 * This view acts as a container for Vue components used to control the active learning workflow.
 * It is reponsible for fetching all of the data needed for the active learning components.
 *
 * Note that in the future, it would likely be better to add endpoints to the plugin to get all of the
 * data in one trip to the server. Additionally, the endpoint could run custom mongo pipelines to provide
 * a paginated view of the predictions for the most recent epoch. This approach would scale better as more
 * images are added to active learning folders. Right now, the client is probably doing too much work.
 */
const ActiveLearningView = View.extend({
    initialize(settings) {
        this.render();
        router.setQuery(); // Ensure we can get the folder from the router
        this.trainingDataFolderId = router.getQuery('folder');
        // TODO create a plugin-level settings for these
        this.activeLearningJobUrl = 'dsarchive_superpixel_latest/SuperpixelClassification';
        this.activeLearningJobType = 'dsarchive/superpixel:latest#SuperpixelClassification';
        this.imageItemsById = {};
        this.annotationsByImageId = {};
        this.sortedSuperpixelIndices = [];
        this.superpixelPredictionsData = [];
        this._isSaving = false;
        this._saveAnnotationsForIds = new Set();
        // Use a map to preserve insertion order
        this.categoryMap = new Map();
        this.histomicsUIConfig = {};

        this.getHistomicsYamlConfig();
    },

    getHistomicsYamlConfig() {
        restRequest({
            url: `folder/${this.trainingDataFolderId}/yaml_config/.histomicsui_config.yaml`
        }).done((config) => {
            // save the config, since we might want to edit it
            this.histomicsUIConfig = config || {};
            this.configAnnotationGroups = (!!config && !!config.annotationGroups)
                ? config.annotationGroups
                : undefined;
            if (!this.configAnnotationGroups) {
                this.configAnnotationGroups = JSON.parse(JSON.stringify(defaultAnnotationGroups));
            }
            this.histomicsUIConfig.annotationGroups = this.configAnnotationGroups;

            const defaultIndex = _.findIndex(this.configAnnotationGroups.groups,
                (group) => group.id === this.configAnnotationGroups.defaultGroup
            );
            const defaultGroup = this.configAnnotationGroups.groups[defaultIndex];
            // Make sure the default category is inserted first
            this.categoryMap.set(defaultGroup.id, {
                label: defaultGroup.id,
                fillColor: defaultGroup.fillColor,
                strokeColor: defaultGroup.lineColor
            });
            this.defaultCategory = this.categoryMap.get(defaultGroup.id);
            _.forEach(this.configAnnotationGroups.groups, (group, index) => {
                this.categoryMap.set(group.id, {
                    label: group.id,
                    fillColor: group.fillColor,
                    strokeColor: group.lineColor
                });
                const oldKey = _.find([...store.hotkeys], ([, v]) => v === index)[0];
                const newKey = JSON.parse(JSON.stringify(group.hotKey || oldKey));
                assignHotkey(oldKey, newKey);
            });

            return this.fetchFoldersAndItems();
        });
    },

    updateHistomicsYamlConfig() {
        const groups = new Map();
        _.forEach(store.categories, (category, index) => {
            const key = _.find([...store.hotkeys], ([, v]) => v === index)[0];
            groups.set(category.label, {
                id: category.label,
                fillColor: category.fillColor,
                lineColor: category.strokeColor || 'rgba(0,0,0,1)',
                hotKey: `${key}`
            });
        });
        this.histomicsUIConfig.annotationGroups.groups = [...groups.values()];

        // Update the config file
        restRequest({
            type: 'PUT',
            url: `folder/${this.trainingDataFolderId}/yaml_config/.histomicsui_config.yaml`,
            data: yaml.dump(this.histomicsUIConfig),
            contentType: 'application/json'
        });
    },

    /**
     * The first of many rest requests needed to get data from the girder server for
     * active learning. Get the child items and folders for the active learning folder.
     */
    fetchFoldersAndItems() {
        this.childFolders = new FolderCollection();
        this.childFolders.fetch({
            parentType: 'folder',
            parentId: this.trainingDataFolderId
        }).done(() => {
            this.childItems = new ItemCollection();
            this.childItems.fetch({ folderId: this.trainingDataFolderId }).done(() => {
                this.checkJobs();
            });
        });
    },

    /**
     * The second rest request. Check for previous jobs with the activeLearningJob type.
     * If there is a job still running, be sure to wait for it to finish before continuing
     * with data gathering and setup.
     */
    checkJobs() {
        restRequest({
            url: 'job/all',
            data: {
                types: `["${this.activeLearningJobType}"]`,
                sort: 'updated'
            }
        }).done((jobs) => {
            const previousJobs = _.filter(jobs, (job) => {
                const kwargs = job.kwargs || {};
                const containerArgs = kwargs.container_args || [];
                const runningOrSuccess = job.status === JobStatus.SUCCESS || job.status === JobStatus.RUNNING;
                return runningOrSuccess && containerArgs.includes(this.trainingDataFolderId);
            });
            if (previousJobs[0]) {
                this.lastRunJobId = previousJobs[0]._id || '';
            }

            if (!previousJobs[0] || previousJobs[0].status !== JobStatus.RUNNING) {
                this.getAnnotations();
            } else {
                // There is a job running
                this.waitForJobCompletion(previousJobs[0]._id);
            }
        });
    },

    startActiveLearning() {
        if (this.activeLearningStep === activeLearningSteps.SuperpixelSegmentation) {
            // Case 1: no superpixel segmentation or feature generation have been done for this
            // folder. We need to get the job XML definition to help populate the form that will
            // be used to tune the first run of the classification job.
            this.getJobXmlUrl();
        } else {
            // Case 2: superpixels/annotations already exist, so we can mount the vue component without
            // retrieving the job XML.
            this.mountVueComponent();
        }
    },

    mountVueComponent() {
        if (this.vueApp) {
            this.vueApp.$destroy();
        }
        const el = this.$('.h-active-learning-container').get(0);
        // eslint-disable-next-line
        const root = (__webpack_public_path__ || '/status/built').replace(/\/$/, '');
        const geojsUrl = root + '/plugins/large_image/extra/geojs.js';
        // Make sure geojs is available, as it required by the image viewer widgets
        $.ajax({
            url: geojsUrl,
            dataType: 'script',
            cache: true
        }).done((resp) => {
            // We will want to refactor the vue components so we only have one container.
            let vm;
            if (this.activeLearningStep >= activeLearningSteps.GuidedLabeling) {
                vm = new ActiveLearningContainer({
                    el,
                    propsData: {
                        router,
                        trainingDataFolderId: this.trainingDataFolderId,
                        annotationsByImageId: this.annotationsByImageId,
                        annotationBaseName: this.annotationBaseName,
                        sortedSuperpixelIndices: this.sortedSuperpixelIndices,
                        apiRoot: getApiRoot(),
                        backboneParent: this,
                        currentAverageCertainty: this.currentAverageCertainty,
                        categoryMap: this.categoryMap
                    }
                });
            } else {
                const imageNamesById = {};
                _.forEach(Object.keys(this.imageItemsById), (imageId) => {
                    imageNamesById[imageId] = this.imageItemsById[imageId].name;
                });
                vm = new ActiveLearningSetupContainer({
                    el,
                    propsData: {
                        backboneParent: this,
                        imageNamesById,
                        annotationsByImageId: this.annotationsByImageId,
                        activeLearningStep: this.activeLearningStep,
                        certaintyMetrics: this.certaintyMetrics
                    }
                });
            }
            this.vueApp = vm;
        });
    },

    render() {
        this.$el.html(learningTemplate());
        return this;
    },

    getAnnotationsForItemPromise(item, annotationsToFetchByImage) {
        return restRequest({
            url: 'annotation',
            data: {
                itemId: item._id,
                sort: 'created',
                sortdir: -1
            }
        }).done((annotations) => {
            // Find the current epoch of training by looking at annotation names.
            // Start by assuming no annotations exist for training. Since running the
            // algorithm once generates annotations for Epoch 0, represent the initial
            // state as epoch -1
            if (!this.epoch) {
                this.epoch = -1;
            }
            _.forEach(annotations, (annotation) => {
                const matches = epochRegex.exec(annotation.annotation.name);
                if (matches) {
                    this.epoch = Math.max(this.epoch, parseInt(matches[1]));
                }
            });
            this.activeLearningStep = Math.min(this.epoch + 1, 2);
            // TODO: refine name checking
            const predictionsAnnotations = _.filter(annotations, (annotation) => {
                return this.annotationIsValid(annotation) && annotation.annotation.name.includes('Predictions');
            });
            const superpixelAnnotations = _.filter(annotations, (annotation) => {
                return this.annotationIsValid(annotation) && !annotation.annotation.name.includes('Predictions');
            });
            const predictions = predictionsAnnotations[0] ? predictionsAnnotations[0]._id : null;
            const labels = superpixelAnnotations[0] ? superpixelAnnotations[0]._id : null;
            annotationsToFetchByImage[item._id] = {
                predictions,
                labels
            };
        });
    },

    /**
     * Wait for a group of promises before moving on to the next setup step.
     *
     * @param {Promise[]} promises
     * @param {function} functionToExecute
     * @param {Object[]} params
     */
    waitForPromises(promises, functionToExecute, params) {
        $.when(...promises).then(() => {
            return functionToExecute.call(this, params);
        });
    },

    /**
     * For each item in the active learning folder, fetch the annotations
     * for that item and build the annotationsToFetchByImageId object.
     */
    getAnnotations() {
        const annotationsToFetchByImage = {};
        const promises = [];
        restRequest({
            url: 'item',
            data: {
                folderId: this.trainingDataFolderId
            }
        }).then((items) => {
            _.forEach(items, (item) => {
                if (item.largeImage) {
                    this.imageItemsById[item._id] = item;
                    this.annotationsByImageId[item._id] = {};
                    promises.push(this.getAnnotationsForItemPromise(item, annotationsToFetchByImage));
                }
            });
            return this.waitForPromises(promises, this.fetchAnnotations, annotationsToFetchByImage);
        });
    },

    /**
     * Determine if an annotation is relevant for active learning.
     *
     * @param {Object} annotation
     * @returns true if the given annotation is part of the
     * active learning workflow
     */
    annotationIsValid(annotation) {
        // TODO: harden filtering of annotations
        return annotation.annotation.name.includes('Superpixel');
    },

    /**
     * Create and populate backbone models for the annotations that are needed
     * for active learning.
     *
     * @param {Object} annotationsToFetchByImage an object whose keys
     * are girder large image item ids and values are objects containing
     * a prediction and a label annotation.
     */
    fetchAnnotations(annotationsToFetchByImage) {
        const promises = [];
        _.forEach(Object.keys(annotationsToFetchByImage), (imageId) => {
            _.forEach(['predictions', 'labels'], (key) => {
                const annotationId = annotationsToFetchByImage[imageId][key];
                if (annotationId) {
                    const backboneModel = new AnnotationModel({ _id: annotationId });
                    promises.push(backboneModel.fetch().done(() => {
                        this.annotationsByImageId[imageId][key] = backboneModel;
                        if (key === 'predictions') {
                            this.computeAverageCertainty(backboneModel);
                        }
                    }));
                }
            });
        });
        $.when(...promises).then(() => {
            this.synchronizeCategories();
            if (this.activeLearningStep === activeLearningSteps.GuidedLabeling) {
                this.getSortedSuperpixelIndices();
            }
            return this.startActiveLearning();
        });
    },

    computeAverageCertainty(annotation) {
        const certaintyArray = annotation.get('annotation').elements[0].user.certainty;
        const sum = _.reduce(certaintyArray, (sum, num) => sum + num, 0);
        this.currentAverageCertainty = sum / certaintyArray.length;
    },

    /**
     * Returns 'Yes' if the predicted category matches the provided label for a superpixel. If
     * a label exists and does not match to prediction, return 'No'. If no label exists, then
     * return undefined
     *
     * TODO: use an agreeChoiceEnum instead of hard-coded Yes, No, undefined. This enum should
     * be available to all views and components that care about this value
     *
     * @param {number} index
     * @param {Object} predictionPixelmapElement
     * @param {Object} labelPixelmapElement
     * @returns A string representing whether or not the machine learning prediction matches
     * the label for the superpixel at the given index. If no label exists for the superpixel,
     * then undefined is returned
     */
    getAgreeChoice(index, predictionPixelmapElement, labelPixelmapElement) {
        const label = labelPixelmapElement.values[index];
        const labelCategories = labelPixelmapElement.categories;
        if (labelCategories[label].label === this.defaultCategory.label) {
            // Label is default, so no choice has been made
            return undefined;
        }
        const predictionCategories = predictionPixelmapElement.categories;
        const prediction = predictionPixelmapElement.values[index];
        return predictionCategories[prediction].label === labelCategories[label].label ? 'Yes' : 'No';
    },

    getAnnotationCategories(pixelmapElement) {
        _.forEach(pixelmapElement.categories, (category) => {
            if (!this.categoryMap.has(category.label)) {
                this.categoryMap.set(category.label, category);
            }
        });
    },

    updateCategoriesAndData(pixelmapElement) {
        // Map old data values to category id
        const dataValuesToCategoryId = new Map();
        _.forEach(pixelmapElement.categories, (category, index) => {
            dataValuesToCategoryId.set(index, category.label);
        });
        // Map category id to new data values
        const categoryIdToNewDataValue = new Map();
        _.forEach([...this.categoryMap.values()], (category, index) => {
            categoryIdToNewDataValue.set(category.label, index);
        });
        // Replace data
        _.forEach(pixelmapElement.values, (value, index) => {
            const category = dataValuesToCategoryId.get(value);
            pixelmapElement.values[index] = categoryIdToNewDataValue.get(category);
        });
        // Replace categories
        pixelmapElement.categories = [...this.categoryMap.values()];
    },

    /**
     * Reconciles the differences between the groups defined in the .histomicsui_config.yaml
     * file and in the annotataions for the current epoch.
     *
     * @returns list of groups to use for labelling superpixels
     */
    synchronizeCategories() {
        const annotations = Object.values(this.annotationsByImageId);
        if (annotations.every((annotation) => _.isEmpty(annotation))) {
            // Nothing to synchronize
            return;
        }

        // Compile all the categories for the dataset
        _.forEach(Object.keys(this.annotationsByImageId), (imageId) => {
            if (this.annotationsByImageId[imageId].labels) {
                const labelPixelmapElement = this.annotationsByImageId[imageId].labels.get('annotation').elements[0];
                this.getAnnotationCategories(labelPixelmapElement);
            }
            if (this.annotationsByImageId[imageId].predictions) {
                const predictionPixelmapElement = this.annotationsByImageId[imageId].predictions.get('annotation').elements[0];
                this.getAnnotationCategories(predictionPixelmapElement);
            }
        });
        // Update pixelmap data for the dataset
        _.forEach(Object.keys(this.annotationsByImageId), (imageId) => {
            if (this.annotationsByImageId[imageId].labels) {
                const labelPixelmapElement = this.annotationsByImageId[imageId].labels.get('annotation').elements[0];
                this.updateCategoriesAndData(labelPixelmapElement);
            }
            if (this.annotationsByImageId[imageId].predictions) {
                const predictionPixelmapElement = this.annotationsByImageId[imageId].predictions.get('annotation').elements[0];
                this.updateCategoriesAndData(predictionPixelmapElement);
            }
        });
        this.saveLabelAnnotations(Object.keys(this.annotationsByImageId));
        // TODO Also save prediction annotations - they might have changed
    },

    /**
     * Build an array of predictions on superpixels sorted by certainty.
     */
    getSortedSuperpixelIndices() {
        const superpixelPredictionsData = [];
        _.forEach(Object.keys(this.annotationsByImageId), (imageId) => {
            if (!this.annotationsByImageId[imageId].predictions) {
                // New images may not have any predictions
                return;
            }
            const annotation = this.annotationsByImageId[imageId].predictions.get('annotation');
            const labels = this.annotationsByImageId[imageId].labels.get('annotation');
            const labelValues = labels.elements[0].values;
            const userData = annotation.elements[0].user;
            const pixelmapValues = annotation.elements[0].values;
            const superpixelImageId = annotation.elements[0].girderId;
            const superpixelCategories = annotation.elements[0].categories;
            const boundaries = annotation.elements[0].boundaries;
            const scale = annotation.elements[0].transform.matrix[0][0];
            _.forEach(userData.certainty, (score, index) => {
                const bbox = userData.bbox.slice(index * 4, index * 4 + 4);
                const agreeChoice = this.getAgreeChoice(index, annotation.elements[0], labels.elements[0]);
                const prediction = {
                    index,
                    confidence: userData.confidence[index],
                    certainty: score,
                    imageId,
                    superpixelImageId,
                    boundaries,
                    scale,
                    bbox,
                    prediction: pixelmapValues[index],
                    predictionCategories: superpixelCategories,
                    labelCategories: labels.elements[0].categories,
                    agreeChoice,
                    selectedCategory: labelValues[index]
                };
                superpixelPredictionsData.push(prediction);
            });
        });
        // TODO: Come back to "this.superpixelPredictionsData" - this works for now,
        // needs to be rethought for use across components
        this.superpixelPredictionsData = superpixelPredictionsData;
        this.sortedSuperpixelIndices = _.sortBy(superpixelPredictionsData, 'certainty');
    },

    getJobXmlUrl() {
        restRequest({
            url: 'slicer_cli_web/docker_image'
        }).then((dockerImages) => {
            const imageAndJob = this.activeLearningJobType.split('#');
            const image = imageAndJob[0].split(':')[0];
            const version = imageAndJob[0].split(':')[1];
            const jobInfo = ((dockerImages[image] || {})[version] || {})[imageAndJob[1]];
            if (!jobInfo) {
                throw new Error('Unable to find specified superpixel classification image.');
            }
            return this.getJobCertaintyChoices(jobInfo.xmlspec);
        });
    },

    /**
     * Flattens a slicer XML spec gui as parsed by girder/slicer_cli_spec to
     * make it easier to quickly extract parameters.
     *
     * @param {object} gui An object returned by parsing a slicer XML spec
     * as returned by the imported `parse` function
     */
    flattenParse(gui) {
        const result = { parameters: {} };
        _.forEach(Object.keys(gui), (key) => {
            if (key !== 'panels') {
                result[key] = gui[key];
            }
        });
        _.forEach(gui.panels, (panel, panelIndex) => {
            _.forEach(panel.groups, (group, groupIndex) => {
                _.forEach(group.parameters, (parameter) => {
                    const param = Object.assign({}, parameter);
                    param.group = {
                        panelIndex,
                        groupIndex
                    };
                    _.forEach(Object.keys(group), (key) => {
                        if (key !== 'parameters') {
                            result.parameters[param.id] = param;
                        }
                    });
                });
            });
        });
        return result;
    },

    /**
     * Extract the certainty options from the superpixel predictions job.
     * @param {string} xmlUrl
     */
    getJobCertaintyChoices(xmlUrl) {
        restRequest({
            url: xmlUrl
        }).then((xmlSpec) => {
            const gui = parse(xmlSpec);
            const flattenedSpec = this.flattenParse(gui);
            const hasCertaintyMetrics = (
                flattenedSpec.parameters.certainty &&
                flattenedSpec.parameters.certainty.values &&
                flattenedSpec.parameters.certainty.values.length
            );
            this.certaintyMetrics = hasCertaintyMetrics ? flattenedSpec.parameters.certainty.values : null;
            return this.mountVueComponent();
        });
    },

    /*****************************************************************
     * Functions in this section should be called by child components
     * (vue components) when they need to perform some kind of rest
     * request or run a job.
     ****************************************************************/

    /**
     * Save the label annotations that are queued to be saved.
     * Prevent multiple save requests from being sent to the server
     * simultaneously.
     * @param {string[]} imageIds
     */
    saveLabelAnnotations(imageIds) {
        _.forEach(imageIds, (id) => {
            this._saveAnnotationsForIds.add(id);
        });
        if (this._isSaving) {
            return;
        }
        this._isSaving = true;
        const promises = [];
        _.forEach(Array.from(this._saveAnnotationsForIds), (imageId) => {
            const labelAnnotation = this.annotationsByImageId[imageId].labels;
            if (labelAnnotation) {
                // Images added without re-train have no labels yet
                const promise = labelAnnotation.save();
                promises.push(promise);
            }
        });
        this._saveAnnotationsForIds = new Set();
        $.when(...promises).then(() => {
            this._isSaving = false;
            if (this._saveAnnotationsForIds.size > 0) {
                this.saveLabelAnnotations([]);
            }
            return true;
        });
    },

    retrain(goToNextStep) {
        restRequest({
            method: 'POST',
            url: `slicer_cli_web/${this.activeLearningJobUrl}/rerun`,
            data: {
                jobId: this.lastRunJobId,
                randominput: false
            }
        }).done((job) => {
            this.waitForJobCompletion(job._id, goToNextStep);
        });
    },

    triggerJob(data, goToNextStep) {
        restRequest({
            method: 'POST',
            url: `slicer_cli_web/${this.activeLearningJobUrl}/run`,
            data
        }).done((response) => {
            const newJobId = response._id;
            this.waitForJobCompletion(newJobId, goToNextStep);
        });
    },

    generateInitialSuperpixels(radius, magnification, certaintyMetric) {
        // get the folders to store annotations, models, features
        const folders = this.childFolders.models;
        const annotationsFolderId = _.filter(folders, (folder) => folder.get('name') === 'Annotations')[0].get('_id');
        const featuresFolderId = _.filter(folders, (folder) => folder.get('name') === 'Features')[0].get('_id');
        const modelsFolderId = _.filter(folders, (folder) => folder.get('name') === 'Models')[0].get('_id');
        const data = {
            images: this.trainingDataFolderId,
            annotationDir: annotationsFolderId,
            features: featuresFolderId,
            magnification,
            radius,
            labels: JSON.stringify([]),
            modeldir: modelsFolderId,
            girderApiUrl: '',
            girderToken: '',
            certainty: certaintyMetric
        };
        this.triggerJob(data, true);
    },

    /****************************************************************
     * Functions related to disabling the UI while a job is running.
     ***************************************************************/

    showSpinner() {
        $('.h-active-learning-container').append(
            '<div class="g-hui-loading-overlay"><div>' +
            '<i class="icon-spin4 animate-spin"><i>' +
            '</div></div>'
        );
    },

    hideSpinner() {
        $('.g-hui-loading-overlay').remove();
    },

    waitForJobCompletion(jobId, goToNextStep) {
        this.showSpinner();
        const poll = setInterval(() => {
            // If this view is no longer rendered in the tab, stop
            // polling the server.
            if (!this.$('.h-active-learning-container').get(0)) {
                clearInterval(poll);
            }
            restRequest({
                url: `job/${jobId}`
            }).done((update) => {
                if (update.status === JobStatus.SUCCESS) {
                    clearInterval(poll);
                    this.hideSpinner();
                    if (goToNextStep) {
                        // We might need to go back to the server for more data
                        this.checkJobs();
                    }
                    this.lastRunJobId = jobId;
                    this.getAnnotations();
                }
                // TODO handle job failure
            });
        }, 2000);
    }
});

export default ActiveLearningView;
