const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldNotify, message } = require('../src/notify-rules');

test('no notification for a session you are looking at', () => {
  assert.equal(shouldNotify({ enabled: true, id: 'a', windowFocused: true, shownIds: ['a'] }), false);
});

test('notifies when Gremlin is in the background, or the session is not on screen', () => {
  assert.equal(shouldNotify({ enabled: true, id: 'a', windowFocused: false, shownIds: ['a'] }), true);
  assert.equal(shouldNotify({ enabled: true, id: 'b', windowFocused: true, shownIds: ['a'] }), true);
  assert.equal(shouldNotify({ enabled: true, id: 'b', windowFocused: true, shownIds: [] }), true);
});

test('the setting and a missing session id switch it off', () => {
  assert.equal(shouldNotify({ enabled: false, id: 'a', windowFocused: false, shownIds: [] }), false);
  assert.equal(shouldNotify({ enabled: true, id: '', windowFocused: false, shownIds: [] }), false);
  assert.equal(shouldNotify({ enabled: true, id: 'a', windowFocused: false }), true);
});

test('finished names the project', () => {
  assert.deepEqual(message('finished', 'G-Icons'), { title: 'Claude finished', body: 'G-Icons' });
});

test('needs-you messages translate the hook types and pass other text through', () => {
  assert.deepEqual(message('attention', 'G-Icons', 'permission_prompt'), { title: 'Claude needs your input', body: 'G-Icons\nWaiting for your permission' });
  assert.equal(message('attention', 'G-Icons', 'elicitation_dialog').body, 'G-Icons\nHas a question for you');
  assert.equal(message('attention', 'G-Icons', 'Run the tests?').body, 'G-Icons\nRun the tests?');
  assert.equal(message('attention', 'G-Icons').body, 'G-Icons\nWaiting for you');
  assert.equal(message('attention', '', '  ').body, 'a project\nWaiting for you');
});

test('message names the host for sessions on other computers', () => {
  assert.deepEqual(message('finished', 'G-Icons', undefined, 'Desk PC'), { title: 'Claude finished', body: 'G-Icons on Desk PC' });
  assert.deepEqual(message('attention', 'G-Icons', 'permission_prompt', 'Desk PC'), { title: 'Claude needs your input', body: 'G-Icons on Desk PC\nWaiting for your permission' });
  assert.deepEqual(message('attention', 'App', undefined, 'Desk PC'), { title: 'Claude needs your input', body: 'App on Desk PC\nWaiting for you' });
});

test('message ignores an empty or non-string host', () => {
  for (const host of [undefined, null, '', '   ', 5, {}]) {
    assert.deepEqual(message('finished', 'App', undefined, host), { title: 'Claude finished', body: 'App' });
  }
});
