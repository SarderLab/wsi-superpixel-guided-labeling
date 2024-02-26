<script>
import Vue from 'vue';
import _ from 'underscore';

import ActiveLearningReviewCard from './ActiveLearningReviewCard.vue';
import ActiveLearningReviewContext from './ActiveLearningReviewContext.vue';
import { store } from '../store.js';

export default Vue.extend({
    components: {
        ActiveLearningReviewCard,
        ActiveLearningReviewContext
    },
    data() {
        return {
            groupedSuperpixels: [],
            groupBy: 0,
            sortBy: 0,
            sortSuperpixelBy: 0,
            filterBy: 0,
            previewSize: 0.5,
            viewerWidget: null,
            selectedSuperpixel: null
        };
    },
    computed: {
        predictionsData() {
            if (store.backboneParent) {
                return store.backboneParent.superpixelPredictionsData;
            }
            return [];
        },
        superpixelsForReview() {
            return _.filter(this.predictionsData, (superpixel) => {
                return superpixel.agreeChoice !== undefined;
            });
        },
        annotationsByImageId() {
            return store.annotationsByImageId;
        },
        categories() {
            return store.categories;
        },
        filterOptions() {
            const categories = _.map(this.categories, (cat) => cat.label);
            return [
                'agree',
                'disagree',
                ...Object.keys(this.annotationsByImageId),
                ...categories
            ];
        }
    },
    watch: {
        groupBy(selection) {
            const sfr = this.superpixelsForReview;
            switch (selection) {
                case 1:
                    // FIXME: Use image name instead of imageId
                    this.groupedSuperpixels = _.groupBy(sfr, 'imageId');
                    break;
                case 2:
                    this.groupedSuperpixels = _.groupBy(sfr, (superpixel) => {
                        return this.categories[superpixel.selectedCategory].label;
                    });
                    break;
                case 3:
                    this.groupedSuperpixels = _.groupBy(sfr, (superpixel) => {
                        const { selectedCategory, prediction } = superpixel;
                        return selectedCategory === prediction ? 'Agree' : 'Disagree';
                    });
                    break;
                default:
                    this.groupedSuperpixels = [];
            }
        }
    },
    methods: {
        sortSuperpixels(sorted) {
            switch (this.sortSuperpixelBy) {
                case 0:
                    sorted = _.sortBy(sorted, 'confidence');
                    break;
                case 1:
                    sorted = _.sortBy(sorted, 'certainty');
                    break;
            }
            switch (this.sortBy) {
                case 1:
                    sorted = _.sortBy(sorted, 'imageId');
                    break;
                case 2:
                    sorted = _.sortBy(sorted, 'selectedCategory');
                    break;
                case 3:
                    sorted = _.sortBy(sorted, (superpixel) => {
                        return superpixel.selectedCategory === superpixel.prediction;
                    });
                    break;
            }
            return sorted;
        },
        filterSuperpixels(data) {
            if (this.filterBy === 'agree') {
                return _.filter(data, (superpixel) => {
                    const { selectedCategory, prediction } = superpixel;
                    return selectedCategory === prediction;
                });
            }
            if (this.filterBy === 'disagree') {
                return _.filter(data, (superpixel) => {
                    const { selectedCategory, prediction } = superpixel;
                    return selectedCategory !== prediction;
                });
            }
            if (this.filterBy in this.annotationsByImageId) {
                return _.filter(data, (superpixel) => {
                    return superpixel.imageId === this.filterBy;
                });
            }
            const labels = _.map(this.categories, (category) => {
                if (category.label !== 'default') {
                    return category.label;
                }
            });
            if (labels.includes(this.filterBy)) {
                return _.filter(data, (superpixel) => {
                    const { selectedCategory, predictionCategories } = superpixel;
                    return predictionCategories[selectedCategory].label === this.filterBy;
                });
            }
            return data;
        },
        filterAndSort(data) {
            return this.sortSuperpixels(this.filterSuperpixels(data));
        },
        categoryColor(superpixel) {
            return this.categories[superpixel.selectedCategory].fillColor;
        }
    }
});
</script>

<template>
  <div class="panel panel-info">
    <active-learning-review-context
      id="context"
      :superpixel="selectedSuperpixel"
    />
    <div class="panel-heading">
      <div class="h-inputs row">
        <div class="col-sm-2">
          <label for="groupby">Group By</label>
          <select
            id="groupby"
            v-model="groupBy"
            class="form-control input-sm"
          >
            <option :value="0">
              -----
            </option>
            <option :value="1">
              Slide
            </option>
            <option :value="2">
              Class
            </option>
            <option :value="3">
              Agree/Disagree
            </option>
          </select>
        </div>
        <div class="col-sm-2">
          <label for="sortby">Sort By</label>
          <select
            id="sortby"
            v-model="sortBy"
            class="form-control input-sm"
          >
            <option :value="0">
              -----
            </option>
            <option :value="1">
              Slide
            </option>
            <option :value="2">
              Class
            </option>
            <option :value="3">
              Agree/Disagree
            </option>
          </select>
        </div>
        <div class="col-sm-2">
          <label for="filterby">Filter By</label>
          <select
            id="filterby"
            v-model="filterBy"
            class="form-control input-sm"
          >
            <option value="none">
              -----
            </option>
            <option
              v-for="item, index in filterOptions"
              :key="index"
              :value="item"
            >
              {{ item }}
            </option>
          </select>
        </div>
        <div class="col-sm-3">
          <label for="sizeSlider">Preview Size</label>
          <input
            id="sizeSlider"
            v-model="previewSize"
            type="range"
            min="0"
            max="1"
            step="0.01"
          >
        </div>
        <div class="col-sm-2">
          <label for="superpixel">Superpixel Sort By</label>
          <select
            id="superpixel"
            v-model="sortSuperpixelBy"
            class="form-control input-sm"
          >
            <option :value="0">
              Confidence
            </option>
            <option :value="1">
              Certainty
            </option>
          </select>
        </div>
        <div class="h-form-buttons col-sm-1">
          <button class="btn btn-primary btn-sm">
            Retrain
          </button>
        </div>
      </div>
    </div>
    <div
      v-if="groupBy !== 0"
      class="panel-content"
    >
      <div
        v-for="[key, value] in Object.entries(groupedSuperpixels)"
        :key="key"
      >
        <h4 :class="[groupBy === 2 && 'group-header']">
          {{ key }} ({{ value.length }})
          <i
            v-if="groupBy === 2"
            class="icon-blank"
            :class="[groupBy === 2 && 'group-icon']"
            :style="{'background-color': categoryColor(value[0])}"
          />
        </h4>
        <hr>
        <div class="panel-content-cards">
          <active-learning-review-card
            v-for="superpixel, index in filterAndSort(value)"
            :key="index"
            :style="[groupBy === 2 ? {'border': 'none'} : {'border-color': categoryColor(superpixel)}]"
            :superpixel="superpixel"
            :preview-size="parseFloat(previewSize)"
            data-toggle="modal"
            data-target="#context"
            @click.native="selectedSuperpixel = superpixel"
          />
        </div>
      </div>
    </div>
    <div
      v-else
      class="panel-content panel-content-cards"
    >
      <active-learning-review-card
        v-for="superpixel, index in filterAndSort(superpixelsForReview)"
        :key="index"
        :style="{'border-color': categoryColor(superpixel)}"
        :superpixel="superpixel"
        :preview-size="parseFloat(previewSize)"
        data-toggle="modal"
        data-target="#context"
        @click.native="selectedSuperpixel = superpixel"
      />
    </div>
  </div>
</template>

<style scoped>
.h-inputs {
  display: flex;
  align-items: flex-end;
}

.h-form-buttons {
  display: flex;
  justify-content: center;
}

.panel-content {
  height: 84vh;
  overflow: scroll;
}

.panel-content-cards {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
}

.group-header {
  display: flex;
  align-items: center;
}

.group-icon {
  height: 20px;
  width: 20px;
  margin-left: 5px;
}
</style>
