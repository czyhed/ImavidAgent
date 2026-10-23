import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoParameters } from '../shared/creation-video-parameters.mjs';
import { validateVideoGeneration } from '../server/providers/creation-video.mjs';

test('video aliases retain orientation and do not mutate the supplied parameters',()=>{
 const original={duration:15,resolution:'1080x1920',aspectRatio:'9:16'};
 assert.deepEqual(normalizeVideoParameters(original),{duration:15,resolution:'1080P',ratio:'9:16'});
 assert.equal(original.resolution,'1080x1920');assert.equal(original.aspectRatio,'9:16');
 assert.deepEqual(normalizeVideoParameters({resolution:'1920 × 1080'}),{resolution:'1080P',ratio:'16:9'});
 assert.deepEqual(normalizeVideoParameters({resolution:'1080p',ratio:'1:1',aspectRatio:'9:16'}),{resolution:'1080P',ratio:'1:1'});
 assert.deepEqual(normalizeVideoParameters({}),{});
});

test('unsupported video settings stay visible and fail validation instead of silently falling back',()=>{
 const model={adapter:'minimax-h3'};
 for(const params of [{resolution:'720P'},{resolution:'123x456'},{aspectRatio:'2:7'},{duration:0},{duration:'15s'},{duration:null},[],null]){
  assert.throws(()=>validateVideoGeneration({params,model,prompt:'test'}),{code:'INVALID_VIDEO_PARAMETERS'});
 }
 assert.equal(normalizeVideoParameters({resolution:'720P'}).resolution,'720P');
 assert.equal(normalizeVideoParameters({aspectRatio:'2:7'}).ratio,'2:7');
});
