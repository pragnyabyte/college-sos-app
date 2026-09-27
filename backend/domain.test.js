import test from 'node:test';
import assert from 'node:assert/strict';
import {canTransition,validateLocation,categories} from './domain.js';
test('configured routing supports multiple departments',()=>{assert.deepEqual(categories.find(c=>c.id==='fire').departmentIds,['DEPT_FIRE','DEPT_SECURITY','DEPT_ADMIN']);assert.equal(categories.find(c=>c.id==='medical').priority,'CRITICAL')});
test('status machine enforces controlled transitions',()=>{assert.equal(canTransition('ACCEPTED','RESPONDING'),true);assert.equal(canTransition('RESOLVED','RESPONDING'),false);assert.equal(canTransition('DEPARTMENT_NOTIFIED','CANCELLED'),true)});
test('location validation bounds coordinates',()=>{assert.throws(()=>validateLocation({building:'A',floor:'1',room:'2',source:'GPS',latitude:99,longitude:1}));assert.equal(validateLocation({building:'A',floor:'1',room:'2',source:'MANUAL'}).source,'MANUAL')});
test('location validation accepts lat/lng aliases and parses coordinates correctly',()=>{const loc=validateLocation({lat:12.971598,lng:77.594566,acc:5.5});assert.equal(loc.latitude,12.971598);assert.equal(loc.longitude,77.594566);assert.equal(loc.accuracy,5.5);assert.equal(loc.locationStatus,'available');assert.equal(loc.source,'GPS');});
test('harassment category is access restricted',()=>assert.equal(categories.find(c=>c.id==='harassment').restricted,true));