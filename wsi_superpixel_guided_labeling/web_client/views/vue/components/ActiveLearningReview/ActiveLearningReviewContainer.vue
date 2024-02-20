<script>
import Vue from 'vue';
import _ from 'underscore';

import ActiveLearningReviewCard from './ActiveLearningReviewCard.vue';
import { store } from '../store.js';

export default Vue.extend({
    components: {
        ActiveLearningReviewCard
    },
    computed: {
        predictionsData() {
            if (store.backboneParent) {
                return store.backboneParent.superpixelPredictionsData;
            }
            return [];
        },
        superpixelsForReview() {
            const sorted = _.sortBy(this.predictionsData, 'certainty');
            return _.filter(sorted, (superpixel) => superpixel.agreeChoice !== undefined);
        },
        rows() {
            return _.range(Math.ceil(this.superpixelsForReview.length / 12));
        }
    }
});
</script>

<template>
  <div class="panel panel-info">
    <div class="panel-heading">
      <div class="h-inputs row">
        <div class="col-sm-2">
          <label for="groupby">Group By</label>
          <select
            id="groupby"
            class="form-control input-sm"
          >
            <option>-----</option>
            <option>Annotator</option>
            <option>Slide</option>
            <option>Class</option>
            <option>Agree</option>
            <option>Disagree</option>
          </select>
        </div>
        <div class="col-sm-2">
          <label for="sortby">Sort By</label>
          <select
            id="sortby"
            class="form-control input-sm"
          >
            <option>-----</option>
            <option>Author</option>
            <option>Slide</option>
            <option>Class</option>
            <option>Agree/Disagree</option>
          </select>
        </div>
        <div class="col-sm-2">
          <label for="filterby">Filter By</label>
          <select
            id="filterby"
            class="form-control input-sm"
          >
            <option>-----</option>
            <option>Author</option>
            <option>Slide</option>
            <option>Class</option>
            <option>Agree/Disagree</option>
          </select>
        </div>
        <div class="col-sm-3" />
        <div class="col-sm-2">
          <label for="superpixel">Superpixel Sort By</label>
          <select
            id="superpixel"
            class="form-control input-sm"
          >
            <option>Confidence</option>
          </select>
        </div>
        <div class="h-form-buttons col-sm-1">
          <button class="btn btn-primary btn-sm">
            Retrain
          </button>
        </div>
      </div>
    </div>
    <div class="panel-content">
      <active-learning-review-card
        v-for="superpixel, index in superpixelsForReview"
        :key="index"
        :superpixel="superpixel"
        sort-value="confidence"
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
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  max-height: 100vh;
  overflow: scroll;
}
</style>
