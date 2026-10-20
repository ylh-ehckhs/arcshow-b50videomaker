import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseScoreReading,scoreBorderCandidate} from '../shared/ocr-score.mjs';

test('isolated score replaces neighbouring-card misread only when the printed rating agrees',()=>{
  const examples=[
    [9950970,9966286,9.3,11.3314],
    [9515777,9919777,9.5,11.2989],
    [9950715,9938713,9.4,11.2936],
    [9955904,9955984,9.3,11.2799],
    [9900107,9988167,9.1,11.2408],
    [9915647,9913647,9.4,11.1682]
  ];
  for(const [current,correct,constant,detectedRating] of examples){
    const result=chooseScoreReading([{value:correct,score:.9}],current,{constant,detectedRating});
    assert.equal(result.value,correct);assert.equal(result.warning,'');
  }
  const mismatch=chooseScoreReading([{value:9988167},{value:9988167}],9900107,{constant:10.1,detectedRating:11.2408});
  assert.equal(mismatch.value,9900107);assert.match(mismatch.warning,/不一致/);
});

test('border artifact repair requires a matching rating and cannot turn arbitrary text into a score',()=>{
  assert.equal(scoreBorderCandidate("109'939′655"),9939655);
  assert.equal(scoreBorderCandidate("109'955'984"),9955984);
  for(const text of ['19939655','109939655 #25','Potential 10.9 > 11.9396','abc09939655'])assert.equal(scoreBorderCandidate(text),null);
  const repaired=[{value:9939655,repaired:true}];
  assert.equal(chooseScoreReading(repaired,null,{constant:9.5,detectedRating:11.3983}).value,9939655);
  assert.equal(chooseScoreReading(repaired,null,{constant:9.5,detectedRating:null}).value,null);
});

test('conflicting readings remain reviewable and absence of rating preserves model agreement',()=>{
  const result=chooseScoreReading([{value:9900000},{value:9900001}],9900000,{constant:10,detectedRating:11.7});
  assert.equal(result.value,9900000);assert.match(result.warning,/候选/);
  assert.equal(chooseScoreReading([{value:9900000},{value:9900000}],null,{constant:10,detectedRating:null}).value,9900000);
});
