import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_BANNER_HEAD,
  DEFAULT_GOAL_TEMPLATE,
  DEFAULT_MAX_TITLE_CHARS,
  DEFAULT_ACTION_WORD,
  MAIN_SESSION_LABEL,
  SUBAGENT_SESSION_LABEL,
  SUBAGENT_TASK_LABEL,
  summarizeGoal,
  summarizeHumanGoal,
  composeBannerText,
  actionWordFor,
  looksLikeInstruction,
  isSubagentSession,
  isDerivedSession,
  isMachineTitle,
  normalizeSessionTitle,
  sessionLabel,
  GoalStore,
  extractUserText,
  isHumanInstruction,
  isHumanInstructionText,
  latestHumanGoal,
  shouldBackfillGoal,
  resolveBackfillGoal,
  backfillGoalFrom,
  shouldRescanHistory,
  GATE_ALLOW,
  GATE_BLOCK,
  createGateState,
  gateStateBlocks,
  nextGateState,
  decideGoalGate,
  hasDeclaredGoal,
  goalStoreKey,
  evaluateGoalGate,
  runGoalGate,
  execTurn,
  gateStateKey,
} from '../lib/goal.mjs';

test('fenced code blocks are dropped from the summary', () => {
  const summary = summarizeGoal('请修一下这个\n```js\nconst a = 1;\n```\n谢谢');
  assert.equal(summary, '请修一下这个 谢谢');
  assert.equal(summarizeGoal('```\n只有代码\n```'), null, 'a message that is only code has no goal');
});

test('an unclosed fence at the end is dropped as well', () => {
  assert.equal(summarizeGoal('帮我看下这个\n```js\nconst a = 1;'), '帮我看下这个');
  assert.equal(summarizeGoal('```js\nconst a = 1;'), null, 'an unclosed fence alone has no goal');
});

test('whitespace runs collapse into a single space', () => {
  assert.equal(summarizeGoal('  打开   记事本 \n\n 然后输入  '), '打开 记事本 然后输入');
  assert.equal(summarizeGoal('打开\t记事本'), '打开 记事本');
});

test('a long summary is cut at the limit and ends with an ellipsis', () => {
  const summary = summarizeGoal('一二三四五六七八九十', 6);
  assert.equal(summary.length, 6);
  assert.ok(summary.endsWith('…'));
  assert.equal(summary, '一二三四五…');
});

test('the default limit is 24 characters and never drops below four', () => {
  assert.equal(DEFAULT_MAX_CHARS, 24);
  const long = 'x'.repeat(40);
  assert.equal(summarizeGoal(long).length, 24);
  assert.ok(summarizeGoal(long).endsWith('…'));
  assert.equal(summarizeGoal('abcdef', 2).length, 4, 'a tiny limit is raised to four');
});

test('an empty or non-string input has no summary', () => {
  assert.equal(summarizeGoal(''), null);
  assert.equal(summarizeGoal('   '), null);
  assert.equal(summarizeGoal(null), null);
  assert.equal(summarizeGoal(undefined), null);
  assert.equal(summarizeGoal(42), null);
  assert.equal(summarizeGoal({ text: 'hello' }), null);
});

test('the banner names the session, the action and the goal', () => {
  assert.equal(DEFAULT_BANNER_HEAD, 'DSH 正在控制电脑');
  assert.equal(DEFAULT_GOAL_TEMPLATE, '目标：{goal}');
  assert.equal(
    composeBannerText('DSH 正在控制电脑', '整理简历', '改简历', '目标：{goal}', '正在点击'),
    'DSH 正在控制电脑 · 会话《整理简历》· 正在点击 · 目标：改简历',
  );
});

test('the goal segment is dropped when there is no goal', () => {
  assert.equal(
    composeBannerText('DSH 正在控制电脑', '整理简历', null, '目标：{goal}', '正在看屏幕'),
    'DSH 正在控制电脑 · 会话《整理简历》· 正在看屏幕',
  );
  assert.equal(
    composeBannerText('DSH 正在控制电脑', '整理简历', undefined, '目标：{goal}', '正在看屏幕'),
    'DSH 正在控制电脑 · 会话《整理简历》· 正在看屏幕',
  );
  assert.equal(
    composeBannerText('DSH 正在控制电脑', '整理简历', '   ', '目标：{goal}', '正在看屏幕'),
    'DSH 正在控制电脑 · 会话《整理简历》· 正在看屏幕',
  );
  assert.ok(
    !composeBannerText('DSH 正在控制电脑', '整理简历', null).includes('目标'),
    'no empty "目标：" is left behind',
  );
});

test('the action segment is always there', () => {
  assert.equal(DEFAULT_ACTION_WORD, '正在操作桌面');
  assert.equal(
    composeBannerText('DSH 正在控制电脑', '整理简历', null),
    'DSH 正在控制电脑 · 会话《整理简历》· 正在操作桌面',
    'an unknown action falls back to a safe word',
  );
  assert.equal(
    composeBannerText('DSH 正在控制电脑', '整理简历', null, '目标：{goal}', '   '),
    'DSH 正在控制电脑 · 会话《整理简历》· 正在操作桌面',
    'a blank action falls back too',
  );
});

test('the banner falls back to a head and a session label', () => {
  assert.equal(composeBannerText('', '', null), 'DSH 正在控制电脑 · 会话《主会话》· 正在操作桌面');
  assert.equal(
    composeBannerText('   ', '  ', null),
    'DSH 正在控制电脑 · 会话《主会话》· 正在操作桌面',
    'blank parts fall back to the defaults',
  );
});

test('a goal template without {goal} is concatenated with the goal', () => {
  assert.equal(
    composeBannerText('DSH 正在控制电脑', '整理简历', '改简历', '正在处理: '),
    'DSH 正在控制电脑 · 会话《整理简历》· 正在操作桌面 · 正在处理: 改简历',
  );
});

// --- The action segment: a fact about the running tool ------------------------
//
// The host knows which official tool is running, so the banner can say what
// is happening right now. That segment is the one part of the banner that is
// always true, even when there is no goal to show.

test('every official tool maps to a Chinese action word', () => {
  const expected = [
    ['get_desktop_state', '正在看屏幕'],
    ['get_window_state', '正在看屏幕'],
    ['get_screenshot', '正在看屏幕'],
    ['click', '正在点击'],
    ['double_click', '正在点击'],
    ['right_click', '正在点击'],
    ['type_text', '正在输入'],
    ['press_key', '正在按键'],
    ['hotkey', '正在按键'],
    ['scroll', '正在滚动'],
    ['drag', '正在拖拽'],
    ['launch_app', '正在启动程序'],
    ['open', '正在启动程序'],
    ['list_windows', '正在查看窗口'],
    ['list_apps', '正在查看窗口'],
    ['get_config', '正在查看窗口'],
    ['move', '正在移动鼠标'],
    ['move_cursor', '正在移动鼠标'],
    ['bring_to_front', '正在切换窗口'],
    ['start_recording', '正在录制屏幕'],
    ['stop_recording', '正在录制屏幕'],
    ['clipboard_read', '正在操作剪贴板'],
    ['clipboard_write', '正在操作剪贴板'],
    ['set_clipboard', '正在操作剪贴板'],
    ['browser_navigate', '正在操作浏览器'],
    ['browser_click', '正在操作浏览器'],
    ['browser_type', '正在操作浏览器'],
    ['browser_pointer', '正在操作浏览器'],
    ['page', '正在操作浏览器'],
  ];
  for (const [tool, word] of expected) {
    assert.equal(actionWordFor(tool), word, `${tool} is ${word}`);
    assert.equal(actionWordFor(`cua_driver_native__${tool}`), word, `the prefixed name works too`);
  }
});

test('an unknown tool falls back to a safe action word', () => {
  assert.equal(actionWordFor('some_tool_nobody_mapped'), DEFAULT_ACTION_WORD);
  assert.equal(actionWordFor('cua_driver_native__some_tool_nobody_mapped'), DEFAULT_ACTION_WORD);
  assert.equal(actionWordFor(''), DEFAULT_ACTION_WORD);
  assert.equal(actionWordFor(null), DEFAULT_ACTION_WORD);
  assert.equal(actionWordFor(undefined), DEFAULT_ACTION_WORD);
  assert.equal(actionWordFor(42), DEFAULT_ACTION_WORD);
});

test('the action word is never empty and never an English tool name', () => {
  for (const tool of ['click', 'type_text', 'brand_new_tool', '']) {
    const word = actionWordFor(tool);
    assert.ok(word.length > 0, 'the action word is never empty');
    assert.ok(!/[a-z_]/i.test(word), 'the action word is Chinese, not the tool name');
  }
});

// --- A question or a complaint is not a task ----------------------------------
//
// The banner once showed the user's own complaint as the goal of the session:
// "现在配置似乎搞的有点复杂我没看懂应该怎么配置". That sentence describes the
// user's trouble, not the work the session is doing.

const COMPLAINT = '现在配置似乎搞的有点复杂我没看懂应该怎么配置，…';
const INSTRUCTION = '把保险库推送目录改成 awesome-dsh-plugin 的 data/plugins/';

test('a complaint is not an instruction', () => {
  assert.equal(looksLikeInstruction(COMPLAINT), false);
  assert.equal(summarizeHumanGoal(COMPLAINT), null, 'the goal is null, not the complaint');
});

test('an instruction is an instruction', () => {
  assert.equal(looksLikeInstruction(INSTRUCTION), true);
  const summary = summarizeHumanGoal(INSTRUCTION);
  assert.ok(summary.startsWith('把保险库推送目录改成'), 'the summary is the instruction');
  assert.ok(summary.endsWith('…'), 'a long instruction is cut at the limit');
  assert.equal(summary.length, DEFAULT_MAX_CHARS);
});

test('a question mark makes a text a question', () => {
  assert.equal(looksLikeInstruction('配置好了吗？'), false);
  assert.equal(looksLikeInstruction('配置好了吗?'), false);
  assert.equal(looksLikeInstruction('把目录改成 data/plugins/ 好吗？'), false);
});

test('every known complaint word makes a text a complaint', () => {
  const words = [
    '似乎', '好像', '为什么', '怎么', '怎么回事', '没看懂', '看不懂',
    '是不是', '能不能', '可不可以', '啊这',
  ];
  for (const word of words) {
    assert.equal(looksLikeInstruction(`${word}这个目录不对`), false, `${word} is a complaint`);
    assert.equal(looksLikeInstruction(`目录不对${word}`), false, `${word} is a complaint anywhere`);
  }
});

test('a text that is too short is not an instruction', () => {
  assert.equal(looksLikeInstruction('好'), false);
  assert.equal(looksLikeInstruction('  改  '), false);
  assert.equal(looksLikeInstruction(''), false);
  assert.equal(looksLikeInstruction(null), false);
  assert.equal(looksLikeInstruction(undefined), false);
  assert.equal(looksLikeInstruction(42), false);
});

test('a complaint in the history is skipped for an earlier instruction', () => {
  const events = [
    messageEvent('user', INSTRUCTION),
    messageEvent('user', COMPLAINT),
  ];
  const goal = latestHumanGoal(events);
  assert.ok(goal.startsWith('把保险库推送目录改成'), 'the complaint does not become the goal');
  assert.ok(!goal.includes('没看懂'), 'the complaint is nowhere in the goal');
});

test('a subagent session is named by its kind', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true);
  assert.equal(isSubagentSession({ header: { origin: 'user' } }), false);
  assert.equal(isSubagentSession({ header: { parentSession: 's1' } }), false, 'a fork is not a subagent');
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession(undefined), false);
});

test('the session label falls back to the kind of the session', () => {
  assert.equal(sessionLabel({ header: { origin: 'subagent' } }, null), '子代理');
  assert.equal(sessionLabel({ header: { origin: 'user' } }, null), '主会话');
  assert.equal(sessionLabel(undefined, null), '主会话');
  assert.equal(sessionLabel({ header: { origin: 'subagent' } }, '真实标题'), '真实标题');
  assert.equal(MAIN_SESSION_LABEL, '主会话');
  assert.equal(SUBAGENT_SESSION_LABEL, '子代理');
});

// --- The identity of a team session in the banner ------------------------------
//
// An AgentTeams member is a child session of its captain, and the host derives
// the session title from the member's first message — the dispatch notice. The
// title therefore reads "AgentTeams automatic task assignment fro…": machine
// words that must not reach the banner, and the reason the user saw no hint
// that a subagent was driving the desktop.

// The title the host really stored for a team member, read from the session
// log (`session/title` event, source `fallback`).
const TEAM_HOST_TITLE = 'AgentTeams automatic task assignment fro';
// The dispatch text itself.
const TEAM_DISPATCH_TEXT = 'AgentTeams automatic task assignment from the shared task list.';
// A title a human would recognize.
const HUMAN_TITLE = '保险库推送目录配置';

test('the machine title of a team session is recognized', () => {
  assert.equal(isMachineTitle(TEAM_DISPATCH_TEXT), true, 'the dispatch text');
  assert.equal(isMachineTitle(TEAM_HOST_TITLE), true, 'the title the host really stores');
  assert.equal(
    isMachineTitle('AgentTeams automatic task assignm…'),
    true,
    'a title the host cut inside the known opening',
  );
  assert.equal(
    isMachineTitle('You are executing as configured member "impl".'),
    true,
    'the other half of the dispatch notice',
  );
});

test('a human title is not machine text', () => {
  assert.equal(isMachineTitle(HUMAN_TITLE), false);
  assert.equal(isMachineTitle('真实标题'), false);
  assert.equal(isMachineTitle('Deploy the plugin to the market'), false);
  assert.equal(isMachineTitle(''), false, 'an empty title is no title');
  assert.equal(isMachineTitle('   '), false);
  assert.equal(isMachineTitle(null), false);
  assert.equal(isMachineTitle(undefined), false);
  assert.equal(isMachineTitle(42), false);
});

test('the machine title judge reuses the existing vocabulary', () => {
  // The same texts the goal judge already rejects are the machine texts.
  for (const text of [TEAM_DISPATCH_TEXT, TEAM_HOST_TITLE, 'Background subagent started', '<system-reminder>']) {
    assert.equal(isHumanInstructionText(text), false, `${text} is not a human instruction`);
    assert.equal(isMachineTitle(text), true, `${text} is not a human title`);
  }
  assert.equal(isHumanInstructionText(HUMAN_TITLE), true);
  assert.equal(isMachineTitle(HUMAN_TITLE), false);
});

test('a derived session is recognized from the header the host really writes', () => {
  // The persisted header of a live AgentTeams member, read from the session
  // log: `origin: 'subagent'`, `delegationDepth: 1` and the captain's id.
  const teamMember = {
    header: {
      version: 4,
      id: '5a4bb5d7-6d67-4cca-8e21-528b1072ce71',
      createdAt: 1793079221941,
      cwd: 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace',
      parentSession: 'session-84145029-efdd-4fb7-bf41-1495a9e45789',
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'cordis',
    },
  };
  assert.equal(isDerivedSession(teamMember), true, 'a team member is a derived session');
  assert.equal(isSubagentSession(teamMember), true, 'the host classifies it as a subagent too');

  // The persisted header of a plain top-level conversation.
  const topLevel = {
    header: {
      version: 4,
      id: 'session-84145029-efdd-4fb7-bf41-1495a9e45789',
      createdAt: 1792737694993,
      cwd: 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace',
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    },
  };
  assert.equal(isDerivedSession(topLevel), false, 'a top-level conversation is not derived');
  assert.equal(isDerivedSession(undefined), false);
  assert.equal(isDerivedSession({}), false);
  assert.equal(isDerivedSession({ header: null }), false);
});

test('any one of the header signals is enough to name a derived session', () => {
  assert.equal(isDerivedSession({ header: { origin: 'subagent' } }), true, 'the host classification');
  assert.equal(isDerivedSession({ header: { delegationDepth: 1 } }), true, 'the delegation depth');
  assert.equal(isDerivedSession({ header: { delegationDepth: 3 } }), true, 'a deeper child is derived too');
  assert.equal(isDerivedSession({ header: { parentSession: 'session-1' } }), true, 'the parent session');
  assert.equal(isDerivedSession({ header: { parentSession: '  ' } }), false, 'a blank parent is no parent');
  assert.equal(isDerivedSession({ header: { delegationDepth: 0 } }), false, 'a top-level session has depth zero');
  assert.equal(isDerivedSession({ header: { origin: 'user' } }), false);
});

test('the banner names a team session by its kind, not by its machine title', () => {
  const teamMember = {
    header: {
      origin: 'subagent',
      delegationDepth: 1,
      parentSession: 'session-84145029-efdd-4fb7-bf41-1495a9e45789',
    },
  };
  assert.equal(sessionLabel(teamMember, TEAM_DISPATCH_TEXT), SUBAGENT_TASK_LABEL);
  assert.equal(sessionLabel(teamMember, TEAM_HOST_TITLE), SUBAGENT_TASK_LABEL, 'the title the host really stores');
  assert.equal(sessionLabel(teamMember, null), SUBAGENT_SESSION_LABEL, 'no title at all');
  assert.equal(sessionLabel(teamMember, HUMAN_TITLE), HUMAN_TITLE, 'a human title is still shown');
  assert.equal(SUBAGENT_TASK_LABEL, '子代理任务');
});

test('a plain session falls back to its own name when its title is machine text', () => {
  assert.equal(sessionLabel({ header: { delegationDepth: 0 } }, TEAM_DISPATCH_TEXT), MAIN_SESSION_LABEL);
  assert.equal(sessionLabel(undefined, TEAM_DISPATCH_TEXT), MAIN_SESSION_LABEL);
  assert.equal(sessionLabel({ header: {} }, null), MAIN_SESSION_LABEL);
});

test('the banner sentence of a team session carries no machine title', () => {
  const teamMember = { header: { origin: 'subagent', delegationDepth: 1 } };
  const label = sessionLabel(teamMember, TEAM_HOST_TITLE);
  const banner = composeBannerText('DSH 正在控制电脑', label, '写插件文件到工作区', '目标：{goal}', '正在操作桌面');
  assert.equal(banner, 'DSH 正在控制电脑 · 会话《子代理任务》· 正在操作桌面 · 目标：写插件文件到工作区');
  assert.ok(!banner.includes('AgentTeams'), 'the machine title is nowhere in the banner');
});

test('a long session title is cut at the limit', () => {
  assert.equal(DEFAULT_MAX_TITLE_CHARS, 30);
  const title = '一二三四五六七八九十'.repeat(4);
  const label = normalizeSessionTitle(title);
  assert.equal(label.length, 30);
  assert.ok(label.endsWith('…'));
  assert.equal(normalizeSessionTitle('短标题'), '短标题');
  assert.equal(normalizeSessionTitle('   '), null);
  assert.equal(normalizeSessionTitle(null), null);
});

test('the goal store keeps sessions apart', () => {
  const store = new GoalStore();
  store.setAutoGoal('s1', '整理桌面');
  store.setAutoGoal('s2', '写周报');
  assert.equal(store.forSession('s1'), '整理桌面');
  assert.equal(store.forSession('s2'), '写周报');
  store.setModelGoal('s2', '改简历');
  assert.equal(store.forSession('s2'), '改简历', 'the model goal wins');
  assert.equal(store.forSession('s1'), '整理桌面', 'the other session is untouched');
});

test('a new instruction drops the model goal of that session', () => {
  const store = new GoalStore();
  store.setModelGoal('s1', '改简历');
  assert.equal(store.forSession('s1'), '改简历');
  store.setAutoGoal('s1', '整理桌面');
  assert.equal(store.forSession('s1'), '整理桌面');
  assert.deepEqual(store.entryFor('s1'), { model: null, auto: '整理桌面' });
  assert.equal(store.forSession('s2'), null, 'other sessions stay empty');
});

test('only a declared goal counts as a declared goal', () => {
  const store = new GoalStore();
  assert.equal(store.hasModelGoal('s1'), false, 'nothing declared yet');
  store.setAutoGoal('s1', '整理桌面');
  assert.equal(store.hasModelGoal('s1'), false, 'the automatic summary is not a declared goal');
  assert.equal(store.forSession('s1'), '整理桌面', 'but it is still the goal of the banner');
  store.setModelGoal('s1', '验收允许清单');
  assert.equal(store.hasModelGoal('s1'), true, 'the model declared one');
  assert.equal(store.hasModelGoal('s2'), false, 'other sessions have none');
  store.setAutoGoal('s1', '整理桌面');
  assert.equal(store.hasModelGoal('s1'), false, 'a new instruction drops the declared goal');
});

test('clearing the model goal keeps the automatic summary', () => {
  const store = new GoalStore();
  store.setAutoGoal('s1', '整理桌面');
  store.setModelGoal('s1', '改简历');
  store.clearModelGoal('s1');
  assert.equal(store.forSession('s1'), '整理桌面');
  assert.deepEqual(store.entryFor('s1'), { model: null, auto: '整理桌面' });
});

test('an unknown session id falls back to the global bucket', () => {
  const store = new GoalStore();
  store.setModelGoal(undefined, '改简历');
  assert.equal(store.forSession(null), '改简历');
  assert.equal(store.forSession('global'), '改简历');
});

test('user text is extracted from every message shape', () => {
  assert.equal(extractUserText('打开记事本'), '打开记事本');
  assert.equal(extractUserText(['第一段', '第二段']), '第一段 第二段');
  assert.equal(extractUserText({ text: '打开记事本' }), '打开记事本');
  assert.equal(extractUserText({ content: '打开记事本' }), '打开记事本');
  assert.equal(extractUserText({ content: [{ type: 'text', text: '打开' }, { type: 'text', text: '记事本' }] }), '打开 记事本');
});

test('an unknown message shape has no user text', () => {
  assert.equal(extractUserText(null), null);
  assert.equal(extractUserText(undefined), null);
  assert.equal(extractUserText(42), null);
  assert.equal(extractUserText({}), null);
  assert.equal(extractUserText('   '), null, 'a blank message has no text');
  assert.equal(extractUserText({ content: [] }), null);
});

test('only a human source counts as an instruction', () => {
  assert.equal(isHumanInstruction({ source: { kind: 'user' } }), true, 'a typed prompt');
  assert.equal(isHumanInstruction({ source: { kind: 'user', rpcId: 'r1' } }), true, 'an RPC prompt');
  assert.equal(isHumanInstruction({ source: { kind: 'user-rpc' } }), true, 'a literal user-rpc discriminant');
});

test('injected context is not a human instruction', () => {
  const injected = [
    'runtime-context', 'working-directory', 'tool-registry', 'user-approval',
    'system-prompt', 'model-selection', 'goal', 'plan-mode', 'schedule',
    'webhook', 'team-message', 'agent-message', 'skill-invocation',
    'user-question-reply', 'compact-checkpoint', 'session-reference',
  ];
  for (const kind of injected) {
    assert.equal(isHumanInstruction({ source: { kind } }), false, `${kind} is not a human instruction`);
  }
  assert.equal(isHumanInstruction({}), false, 'a message without a source is unknown');
  assert.equal(isHumanInstruction(null), false);
  assert.equal(isHumanInstruction('user'), false, 'a bare string is not a message');
});

// --- Machine text is not a goal -------------------------------------------------
//
// The source kind alone is not enough: an AgentTeams task dispatch reaches the
// subagent as a plain `user` message, so the text itself has to be checked.
// These cases pin the real text that produced the bad banner.

const AGENT_TEAMS_DISPATCH = 'AgentTeams automatic task assignment from the shared task list. You are executing as configured member';

test('the AgentTeams dispatch is not a human instruction', () => {
  assert.equal(isHumanInstructionText(AGENT_TEAMS_DISPATCH), false);
  assert.equal(summarizeHumanGoal(AGENT_TEAMS_DISPATCH), null, 'the goal is null, not a fallback');
  assert.equal(
    latestHumanGoal([{ type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: AGENT_TEAMS_DISPATCH }] } }]),
    null,
    'a dispatch never becomes the goal of a session',
  );
});

test('a dispatch after a human instruction leaves the human goal alone', () => {
  const events = [
    { type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我整理桌面' }] } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: AGENT_TEAMS_DISPATCH }] } },
  ];
  assert.equal(latestHumanGoal(events), '帮我整理桌面');
});

test('every known machine opening is not a human instruction', () => {
  const openings = [
    '<system-reminder>the workspace rules</system-reminder>',
    '<continuum_resume>the session continues</continuum_resume>',
    '[MNEMON] runtime memory snapshot',
    'Current runtime context: node v22, cwd C:/work',
    'Time sampled while preparing turn 3, step 1',
    'AgentTeams automatic task assignment from the shared task list.',
    'Background subagent finished with result 42',
  ];
  for (const text of openings) {
    assert.equal(isHumanInstructionText(text), false, `${text} is machine text`);
    assert.equal(summarizeHumanGoal(text), null);
  }
});

test('every known machine fragment is not a human instruction', () => {
  const fragments = [
    'You are executing as configured member "impl".',
    'The approval policy changed to never ask again.',
    'The user switched this session to plan mode.',
    '[model changed] the session now runs another model',
  ];
  for (const text of fragments) {
    assert.equal(isHumanInstructionText(text), false, `${text} is machine text`);
    assert.equal(summarizeHumanGoal(text), null);
  }
});

test('a long English text is machine context', () => {
  const long = 'Please open the notepad application and write a short note about the meeting tomorrow morning';
  assert.equal(isHumanInstructionText(long), false, 'a long English paragraph is injected context');
  assert.equal(summarizeHumanGoal(long), null);
});

test('a short English text and every Chinese text stay human', () => {
  assert.equal(isHumanInstructionText('open notepad'), true);
  assert.equal(isHumanInstructionText('帮我整理桌面'), true);
  assert.equal(isHumanInstructionText('打开记事本，然后输入一行字'), true);
  assert.equal(summarizeHumanGoal('帮我整理桌面'), '帮我整理桌面');
});

test('a text that is not a string is not a human instruction', () => {
  assert.equal(isHumanInstructionText(null), false);
  assert.equal(isHumanInstructionText(undefined), false);
  assert.equal(isHumanInstructionText(42), false);
  assert.equal(isHumanInstructionText(''), false);
  assert.equal(isHumanInstructionText('   '), false);
  assert.equal(summarizeHumanGoal(null), null);
});

test('a deleted session leaves no goal behind', () => {
  const store = new GoalStore();
  store.setAutoGoal('s1', '整理桌面');
  store.setModelGoal('s2', '改简历');
  assert.equal(store.delete('s1'), true, 'the bucket was removed');
  assert.equal(store.forSession('s1'), null);
  assert.equal(store.delete('s1'), false, 'deleting twice is a no-op');
  assert.equal(store.forSession('s2'), '改简历', 'other sessions are untouched');
});

// --- The declared goal survives the turn --------------------------------------
//
// The plugin used to clear the goal the model reported on every `turn/end`,
// so the second turn of a session fell back to the automatic summary — and a
// complaint of the user ended up in the banner. The goal is now dropped only
// when the session is gone (`agent/disposed`) or when a new instruction
// arrives (`user/message`). The wiring lives in lib/index.js, which needs a
// host to run, so the one line that must not come back is pinned here.

test('the store keeps the declared goal until a new instruction arrives', () => {
  const store = new GoalStore();
  store.setModelGoal('s1', '验收允许清单');
  // A turn boundary does not touch the store.
  assert.equal(store.forSession('s1'), '验收允许清单');
  // A new instruction is what replaces it.
  store.setAutoGoal('s1', '把保险库推送目录改成 data/plugins/');
  assert.equal(store.forSession('s1'), '把保险库推送目录改成 data/plugins/');
  assert.deepEqual(store.entryFor('s1'), { model: null, auto: '把保险库推送目录改成 data/plugins/' });
});

test('the plugin does not clear the declared goal when a turn ends', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(
    !/turn\/end[\s\S]{0,400}clearModelGoal/.test(source),
    'the turn/end handler must not clear the model goal',
  );
});

// --- Session history backfill -------------------------------------------------

/** One `user/message` event as the session log stores it. */
const messageEvent = (kind, text) => ({
  type: 'user/message',
  seq: 0,
  time: 0,
  data: {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  },
});

test('the latest human instruction is found among injected context', () => {
  const events = [
    { type: 'session/start', seq: 0, time: 0, data: {} },
    messageEvent('runtime-context', '环境快照：工作目录 C:/work'),
    messageEvent('agent-instructions', '你是一个助手'),
    messageEvent('skill-catalog', '可用技能列表'),
    { type: 'assistant/message', seq: 4, time: 4, data: { message: { role: 'assistant', content: [] } } },
    messageEvent('user', '帮我整理桌面'),
  ];
  assert.equal(latestHumanGoal(events), '帮我整理桌面');
});

test('the newest human instruction wins over an earlier one', () => {
  const events = [
    messageEvent('user', '先打开记事本'),
    messageEvent('user', '然后整理桌面'),
  ];
  assert.equal(latestHumanGoal(events), '然后整理桌面');
});

test('a history without a human instruction has no goal', () => {
  const events = [
    messageEvent('runtime-context', '环境快照'),
    messageEvent('agent-teams', '团队消息'),
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 1 } },
  ];
  assert.equal(latestHumanGoal(events), null);
});

test('an empty history has no goal', () => {
  assert.equal(latestHumanGoal([]), null);
  assert.equal(latestHumanGoal(undefined), null);
  assert.equal(latestHumanGoal(null), null);
  assert.equal(latestHumanGoal('not an array'), null);
});

test('a backfilled goal is cut at the character limit', () => {
  const events = [messageEvent('user', '一二三四五六七八九十')];
  const goal = latestHumanGoal(events, 6);
  assert.equal(goal.length, 6);
  assert.ok(goal.endsWith('…'));
  assert.equal(goal, '一二三四五…');
});

test('a backfilled goal uses the default limit', () => {
  const events = [messageEvent('user', 'x'.repeat(40))];
  assert.equal(latestHumanGoal(events).length, DEFAULT_MAX_CHARS);
});

test('a human message without readable text is skipped for an earlier one', () => {
  const events = [
    messageEvent('user', '帮我整理桌面'),
    messageEvent('user', '   '),
  ];
  assert.equal(latestHumanGoal(events), '帮我整理桌面');
});

// --- Backfill rules ----------------------------------------------------------

test('only a session without a goal is backfilled', () => {
  assert.equal(shouldBackfillGoal(null), true, 'no goal yet');
  assert.equal(shouldBackfillGoal(undefined), true, 'no goal yet');
  assert.equal(shouldBackfillGoal('改简历'), false, 'a goal is already there');
  assert.equal(shouldBackfillGoal(''), false, 'a goal is already there');
});

test('the goal a session has always outranks the recovered one', () => {
  const events = [messageEvent('user', '历史里的旧指令')];

  const withModelGoal = resolveBackfillGoal('改简历', events);
  assert.equal(withModelGoal.recovered, false, 'the model goal is kept');
  assert.equal(withModelGoal.goal, '改简历');

  const withAutoGoal = resolveBackfillGoal('整理桌面', events);
  assert.equal(withAutoGoal.recovered, false, 'the automatic summary is kept');
  assert.equal(withAutoGoal.goal, '整理桌面');
});

test('a session without a goal takes the one from its history', () => {
  const events = [
    messageEvent('runtime-context', '环境快照'),
    messageEvent('user', '帮我整理桌面'),
  ];
  const resolved = resolveBackfillGoal(null, events);
  assert.equal(resolved.recovered, true);
  assert.equal(resolved.goal, '帮我整理桌面');
});

test('a history without an instruction recovers nothing', () => {
  const resolved = resolveBackfillGoal(null, [messageEvent('runtime-context', '环境快照')]);
  assert.equal(resolved.recovered, false);
  assert.equal(resolved.goal, null);
});

test('a recovered goal never replaces the model goal in the store', () => {
  const store = new GoalStore();
  store.setModelGoal('s1', '改简历');
  const events = [messageEvent('user', '历史里的旧指令')];

  const goal = backfillGoalFrom(store, 's1', events);
  assert.equal(goal, null, 'nothing was recovered');
  assert.equal(store.forSession('s1'), '改简历', 'the model goal survived');
  assert.deepEqual(store.entryFor('s1'), { model: '改简历', auto: null });
});

test('a recovered goal never replaces the automatic summary in the store', () => {
  const store = new GoalStore();
  store.setAutoGoal('s1', '打开记事本');
  const events = [messageEvent('user', '历史里的旧指令')];

  const goal = backfillGoalFrom(store, 's1', events);
  assert.equal(goal, null, 'nothing was recovered');
  assert.equal(store.forSession('s1'), '打开记事本', 'the summary survived');
  assert.deepEqual(store.entryFor('s1'), { model: null, auto: '打开记事本' });
});

test('a session without a goal gets one from its history', () => {
  const store = new GoalStore();
  const events = [
    messageEvent('runtime-context', '环境快照'),
    messageEvent('user', '帮我整理桌面'),
  ];

  const goal = backfillGoalFrom(store, 's1', events);
  assert.equal(goal, '帮我整理桌面');
  assert.equal(store.forSession('s1'), '帮我整理桌面');
  assert.deepEqual(store.entryFor('s1'), { model: null, auto: '帮我整理桌面' });
});

test('a backfill leaves other sessions alone', () => {
  const store = new GoalStore();
  store.setModelGoal('s2', '改简历');
  const goal = backfillGoalFrom(store, 's1', [messageEvent('user', '帮我整理桌面')]);
  assert.equal(goal, '帮我整理桌面');
  assert.equal(store.forSession('s2'), '改简历', 'the other session is untouched');
});

test('a failed scan is retried, a settled one is not', () => {
  // No scan yet: the first attempt runs.
  assert.equal(shouldRescanHistory(undefined, 4), true);
  // A settled scan of an unchanged history does not run again.
  assert.equal(shouldRescanHistory(4, 4), false);
  // The history grew, so the new events may hold an instruction.
  assert.equal(shouldRescanHistory(4, 7), true);
  // The length cannot be measured: do not scan on every desktop call.
  assert.equal(shouldRescanHistory(null, 4), false);
});

// --- The early return that keeps the history unopened -------------------------
//
// The plugin reads the goal before it opens a session's history: a session
// that already has one is skipped outright, so its history is never scanned.
// These cases pin that decision, so the check cannot drift back behind the
// scan.

test('a session with a model goal needs no history scan', () => {
  const store = new GoalStore();
  store.setModelGoal('s1', '改简历');
  assert.equal(shouldBackfillGoal(store.forSession('s1')), false, 'the scan is skipped');
});

test('a session with an automatic summary needs no history scan', () => {
  const store = new GoalStore();
  store.setAutoGoal('s1', '打开记事本');
  assert.equal(shouldBackfillGoal(store.forSession('s1')), false, 'the scan is skipped');
});

test('a backfilled session needs no further history scan', () => {
  const store = new GoalStore();
  const goal = backfillGoalFrom(store, 's1', [messageEvent('user', '帮我整理桌面')]);
  assert.equal(goal, '帮我整理桌面');
  // The recovered goal is in the store, so the next desktop call skips the
  // history instead of reading it again.
  assert.equal(shouldBackfillGoal(store.forSession('s1')), false, 'the scan is skipped');
});

test('a session without a goal still reads its history', () => {
  const store = new GoalStore();
  assert.equal(shouldBackfillGoal(store.forSession('s1')), true, 'the scan runs');
});

// --- The gate in front of the desktop --------------------------------------------
//
// The gate is the only rule of this plugin that can send a desktop call back,
// so its semantics are pinned here as plain functions. The plugin itself only
// keeps the state of the gate and turns the decision into an error; it never
// decides on its own, so the rules cannot exist in two places.
//
// The five cases below are the whole contract of the gate:
//   1. a declared goal opens it;
//   2. without one, the first call of a turn is sent back;
//   3. the second call of the same turn is let through — never a deadlock;
//   4. a new turn is sent back again — the block does not carry over;
//   5. an automatic summary is not a declared goal — it cannot open the gate.

test('a declared goal opens the gate', () => {
  assert.equal(decideGoalGate(true, false), GATE_ALLOW, 'a declared goal lets the call through');
  assert.equal(decideGoalGate(true, true), GATE_ALLOW, 'the declared goal wins over the block record');
});

test('the first call of a turn without a declared goal is sent back', () => {
  const state = createGateState('s1');
  assert.equal(gateStateBlocks(state, 1), false, 'this turn was not sent back yet');
  assert.equal(decideGoalGate(false, gateStateBlocks(state, 1)), GATE_BLOCK);
});

test('the second call of the same turn is let through', () => {
  let state = createGateState('s1');
  state = nextGateState(state, 1);
  assert.equal(gateStateBlocks(state, 1), true, 'this turn was sent back once');
  assert.equal(
    decideGoalGate(false, gateStateBlocks(state, 1)),
    GATE_ALLOW,
    'the retry inside the same turn is never locked out',
  );
});

test('a new turn is sent back again', () => {
  let state = createGateState('s1');
  state = nextGateState(state, 1);
  assert.equal(
    decideGoalGate(false, gateStateBlocks(state, 2)),
    GATE_BLOCK,
    'the block of the first turn does not carry over',
  );
  state = nextGateState(state, 2);
  assert.deepEqual(state.blockedTurns, ['1', '2'], 'both turns are remembered');
  assert.equal(decideGoalGate(false, gateStateBlocks(state, 2)), GATE_ALLOW, 'the retry of the new turn passes');
});

test('an automatic summary does not open the gate', () => {
  const store = new GoalStore();
  store.setAutoGoal('s1', '整理桌面');
  assert.equal(store.hasModelGoal('s1'), false, 'the summary is not a declared goal');
  assert.equal(hasDeclaredGoal(store, 's1', 's1'), false, 'so the gate does not see one');
  assert.equal(
    decideGoalGate(hasDeclaredGoal(store, 's1', 's1'), false),
    GATE_BLOCK,
    'the summary cannot open the gate',
  );
  store.setModelGoal('s1', '验收允许清单');
  assert.equal(hasDeclaredGoal(store, 's1', 's1'), true, 'the declared goal opens it');
  assert.equal(decideGoalGate(hasDeclaredGoal(store, 's1', 's1'), false), GATE_ALLOW);
});

test('the gate state remembers a turn once', () => {
  const state = nextGateState(nextGateState(createGateState('s1'), 1), 1);
  assert.deepEqual(state.blockedTurns, ['1'], 'the turn is not counted twice');
  assert.equal(state.sessionId, 's1');
});

test('a goal declared under the id of the agent is a second chance', () => {
  const store = new GoalStore();
  store.setModelGoal('agent-1', '验收允许清单');
  assert.equal(hasDeclaredGoal(store, 'session-1', 'agent-1'), true, 'the agent id is checked as well');
  assert.equal(hasDeclaredGoal(store, 'session-1', 'session-1'), false, 'another id does not count');
});

// --- The wiring of the gate, as one pure function --------------------------------
//
// `decideGoalGate` pins the rule, but the rule is not the whole gate: the
// gate also has to read the declared goal, read the block record of *this*
// turn, and remember the turn it sent back. That wiring used to live in
// lib/index.js, where no test can reach it — a mistake there (a hard-coded
// `alreadyBlocked`, a lost turn, a state that was written under another key)
// left the whole suite green while the gate degraded into a permanent block.
//
// Two units carry it now, both in lib/goal.mjs:
//   `evaluateGoalGate` — reads the facts and decides, without writing;
//   `runGoalGate`      — evaluates and remembers the turn it sent back, by
//                        writing into the state container itself.
// The plugin only reads the decision, so a mistake in the wiring is a test
// case instead of a surprise at the desktop.

/** A gate state container that holds one session's state. */
const gateStatesWith = (sessionId, state) => new Map([[sessionId, state]]);

test('the gate decision values are the ones the plugin compares', () => {
  assert.equal(GATE_ALLOW, 'allow');
  assert.equal(GATE_BLOCK, 'block');
});

test('a declared goal opens the gate, whatever the block record says', () => {
  const store = new GoalStore();
  store.setModelGoal('s1', '验收允许清单');
  // This turn was sent back before, but the goal was declared afterwards.
  const states = gateStatesWith('s1', nextGateState(createGateState('s1'), 1));
  const evaluation = evaluateGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(evaluation.declared, true, 'the declared goal is seen');
  assert.equal(evaluation.alreadyBlocked, true, 'the block record of this turn is read');
  assert.equal(evaluation.decision, GATE_ALLOW, 'a declared goal opens the gate');
});

test('a declared goal opens the gate before the turn was ever sent back', () => {
  const store = new GoalStore();
  store.setModelGoal('s1', '验收允许清单');
  const evaluation = evaluateGoalGate(store, new Map(), { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(evaluation.declared, true, 'the declared goal is seen');
  assert.equal(evaluation.alreadyBlocked, false, 'this turn was never sent back');
  assert.equal(evaluation.decision, GATE_ALLOW, 'the very first call of a turn passes');
});

test('without a declared goal the first call of a turn is sent back', () => {
  const store = new GoalStore();
  const evaluation = evaluateGoalGate(store, new Map(), { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(evaluation.declared, false, 'nothing was declared');
  assert.equal(evaluation.alreadyBlocked, false, 'this turn was not sent back yet');
  assert.equal(evaluation.decision, GATE_BLOCK, 'the call is sent back');
  assert.deepEqual(evaluation.nextState.blockedTurns, ['1'], 'the state remembers this turn');
  assert.equal(evaluation.nextState.sessionId, 's1', 'the state belongs to that session');
});

test('the retry inside the same turn is let through', () => {
  const store = new GoalStore();
  // The state says this turn was already sent back.
  const states = gateStatesWith('s1', nextGateState(createGateState('s1'), 1));
  const evaluation = evaluateGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(evaluation.alreadyBlocked, true, 'the block record of this turn is read');
  assert.equal(evaluation.decision, GATE_ALLOW, 'the retry is never locked out');
  assert.deepEqual(evaluation.nextState.blockedTurns, ['1'], 'the state is left alone');
});

test('a new turn is sent back again', () => {
  const store = new GoalStore();
  const states = gateStatesWith('s1', nextGateState(createGateState('s1'), 1));
  const evaluation = evaluateGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 2 });
  assert.equal(evaluation.alreadyBlocked, false, 'the block of turn 1 does not carry over');
  assert.equal(evaluation.decision, GATE_BLOCK, 'the new turn is sent back');
  assert.deepEqual(evaluation.nextState.blockedTurns, ['1', '2'], 'both turns are remembered');
});

test('an automatic summary does not open the gate', () => {
  const store = new GoalStore();
  store.setAutoGoal('s1', '整理桌面');
  const evaluation = evaluateGoalGate(store, new Map(), { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(evaluation.declared, false, 'the summary is not a declared goal');
  assert.equal(evaluation.decision, GATE_BLOCK, 'the summary cannot open the gate');
});

test('a goal declared under the id of the agent opens the gate too', () => {
  const store = new GoalStore();
  store.setModelGoal('agent-1', '验收允许清单');
  const evaluation = evaluateGoalGate(store, new Map(), {
    sessionId: 'session-1',
    agentId: 'agent-1',
    turn: 1,
  });
  assert.equal(evaluation.declared, true, 'the agent id is checked as well');
  assert.equal(evaluation.decision, GATE_ALLOW, 'the gate opens');
});

test('the evaluation never writes to the state container', () => {
  const store = new GoalStore();
  const states = new Map();
  evaluateGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(states.size, 0, 'the pure function stores nothing by itself');
});

// --- The turn of a call, and what happens when there is none --------------------
//
// The gate counts per turn: it sends a call back once per turn and lets the
// retry inside that turn through. So a turn that is missing, or that is not a
// turn at all, is not a small detail — it decides whether the gate counts
// anything. The gate therefore checks the turn it was given and fails open
// when it is unusable: a gate that locks the desktop out because of a
// missing number is worse than no gate at all.

test('the turn of a call is read from the host execution', () => {
  assert.equal(execTurn({ agent: { phase: { kind: 'running', turn: 7 } } }), 7);
  assert.equal(execTurn({ agent: { phase: { kind: 'running', turn: '7' } } }), '7');
  assert.equal(execTurn({ agent: { phase: { kind: 'thinking' } } }), undefined, 'no running turn');
  assert.equal(execTurn({ agent: {} }), undefined, 'no phase at all');
  assert.equal(execTurn(undefined), undefined);
});

test('a call without a turn is let through instead of being locked out', () => {
  const store = new GoalStore();
  const states = new Map();
  const evaluation = evaluateGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: undefined });
  assert.equal(evaluation.missingTurn, true, 'the missing turn is reported');
  assert.equal(evaluation.decision, GATE_ALLOW, 'the call goes through');
  assert.equal(evaluation.alreadyBlocked, false);
  assert.equal(states.size, 0, 'nothing was remembered');
});

test('a null turn is a missing turn as well', () => {
  const store = new GoalStore();
  const evaluation = evaluateGoalGate(store, new Map(), { sessionId: 's1', agentId: 's1', turn: null });
  assert.equal(evaluation.missingTurn, true, 'the missing turn is reported');
  assert.equal(evaluation.decision, GATE_ALLOW, 'the call goes through');
});

test('a run without a turn lets the call through and remembers nothing', () => {
  const store = new GoalStore();
  const states = new Map();
  const run = runGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: undefined });
  assert.equal(run.missingTurn, true, 'the missing turn is reported');
  assert.equal(run.decision, GATE_ALLOW, 'the call goes through');
  assert.equal(run.recorded, false, 'nothing was remembered');
  assert.equal(states.size, 0, 'the container is untouched');
});

test('a turn of zero is a turn', () => {
  const store = new GoalStore();
  const evaluation = evaluateGoalGate(store, new Map(), { sessionId: 's1', agentId: 's1', turn: 0 });
  assert.equal(evaluation.missingTurn, false, 'zero names a turn');
  assert.equal(evaluation.decision, GATE_BLOCK, 'the first call of that turn is sent back');
});

// --- The run of the gate: it remembers the turn it sent back --------------------
//
// The step that writes the block record used to sit in lib/index.js, next to
// the gate and outside every test. It is inside the tested unit now: the run
// writes into the state container itself, so "the retry of this turn goes
// through" is a fact the tests can see in the container.

test('the run of the gate remembers the turn it sent back', () => {
  const store = new GoalStore();
  const states = new Map();
  const run = runGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(run.decision, GATE_BLOCK, 'the call was sent back');
  assert.equal(run.recorded, true, 'the turn was recorded');
  assert.equal(states.has('s1'), true, 'the container holds the state');
  assert.deepEqual(states.get('s1').blockedTurns, ['1'], 'the turn is in the block record');
});

test('the retry of the same turn goes through because the run remembered it', () => {
  const store = new GoalStore();
  const states = new Map();
  runGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  const retry = runGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(retry.decision, GATE_ALLOW, 'the retry is not locked out');
  assert.equal(retry.alreadyBlocked, true, 'the run read its own record');
  assert.deepEqual(states.get('s1').blockedTurns, ['1'], 'the record is not written twice');
});

test('a new turn is sent back again after the run remembered the old one', () => {
  const store = new GoalStore();
  const states = new Map();
  runGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  const next = runGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 2 });
  assert.equal(next.decision, GATE_BLOCK, 'the new turn is sent back');
  assert.deepEqual(states.get('s1').blockedTurns, ['1', '2'], 'both turns are remembered');
});

test('the run leaves the container alone when it lets the call through', () => {
  const store = new GoalStore();
  store.setModelGoal('s1', '验收允许清单');
  const states = new Map();
  const run = runGoalGate(store, states, { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(run.decision, GATE_ALLOW, 'the declared goal opens the gate');
  assert.equal(run.recorded, false, 'nothing was recorded');
  assert.equal(states.size, 0, 'the container is untouched');
});

test('the run fails open when there is nowhere to remember the block', () => {
  const store = new GoalStore();
  const run = runGoalGate(store, undefined, { sessionId: 's1', agentId: 's1', turn: 1 });
  assert.equal(run.decision, GATE_ALLOW, 'the desktop stays usable');
  assert.equal(run.recorded, false, 'nothing was recorded');
});

test('the gate state of a session is stored under one shared key', () => {
  assert.equal(gateStateKey('s1', 's1'), 's1', 'the session id is the key');
  assert.equal(gateStateKey('session-1', 'agent-1'), 'session-1', 'the agent id is only the fallback');
  assert.equal(gateStateKey(undefined, 'agent-1'), 'agent-1');
  assert.equal(gateStateKey(undefined, undefined), 'global');
  assert.equal(
    gateStateKey('s1', 'agent-1'),
    goalStoreKey('s1', 'agent-1'),
    'the goal and the gate state share one key',
  );
});

// --- One key for the goal: the id of the session --------------------------------
//
// The banner reads the goal under the id of the session that holds the desktop
// lease, so the store has to use that very key. The host names the agent and
// its session with the same id today, but the banner must not depend on that:
// a host that names them apart would silently fall back to the automatic
// summary.

test('the goal is stored under the id of the session', () => {
  assert.equal(goalStoreKey('session-1', 'agent-1'), 'session-1', 'the session id is the key');
  assert.equal(goalStoreKey('session-1', 'session-1'), 'session-1');
  assert.equal(goalStoreKey(undefined, 'agent-1'), 'agent-1', 'the agent id is only the fallback');
  assert.equal(goalStoreKey('', 'agent-1'), 'agent-1');
  assert.equal(goalStoreKey(undefined, undefined), 'global');
});

test('the banner finds the declared goal when the host names agent and session apart', () => {
  const store = new GoalStore();
  const sessionId = goalStoreKey('session-1', 'agent-1');
  store.setModelGoal(sessionId, '验收允许清单');
  assert.equal(store.forSession('session-1'), '验收允许清单', 'the key of the banner finds it');
  assert.equal(store.forSession('agent-1'), null, 'nothing was stored under the id of the agent');
});

test('the plugin stores the declared goal under the id of the session', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(
    /goalStoreKey\(exec\?\.agent\?\.session\?\.id, exec\?\.agent\?\.id\)/.test(source),
    'the session id is the key, the id of the agent only the fallback',
  );
});

test('the plugin asks the tested unit and never wires the gate itself', () => {
  // The wiring is pinned by the cases above, but lib/index.js cannot be
  // unit-tested without a host. This guard is only a second line of defence:
  // the shell may call the tested unit and act on the decision, but it may not
  // assemble the facts of the decision (the declared goal, the block record)
  // and it may not write the gate state itself — the "remember this turn"
  // step belongs inside the unit, where a mistake is a failing test.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('runGoalGate('), 'the gate runs through the tested unit');
  assert.ok(!source.includes('evaluateGoalGate('), 'the plugin does not evaluate by itself');
  assert.ok(!source.includes('decideGoalGate('), 'the plugin does not decide on its own');
  assert.ok(!source.includes('gateStateBlocks('), 'the plugin does not read the block record on its own');
  assert.ok(!source.includes('nextGateState('), 'the plugin does not build the next state on its own');
  assert.ok(
    !/states\s*\.\s*set\s*\(/i.test(source),
    'the plugin does not write the gate state itself',
  );
});

test('the plugin hands the turn to the gate', () => {
  // The turn says which call is the first of a turn and which is the retry
  // inside it. It is read out of the host by `execTurn` and handed over with
  // the context; if the hand-over ever lost the turn, the gate would stop
  // counting and the call site would be the only place that knew.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const call = /runGoalGate\([\s\S]*?\{([\s\S]*?)\}\s*\)/.exec(source);
  assert.ok(call !== null, 'the gate is called with a context object');
  assert.ok(/\bturn\b/.test(call[1]), 'the context carries the turn');
});

test('the plugin forgets the gate state under the key the gate wrote it', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const clear = /function clearGate\([\s\S]*?\n {2}\}/.exec(source);
  assert.ok(clear !== null, 'the gate state is forgotten by clearGate');
  assert.ok(
    clear[0].includes('gateStateKey('),
    'the state is forgotten under the very key the gate wrote it under',
  );
});

// --- The version of the plugin --------------------------------------------------
//
// The version is asserted against `package.json` itself, never against a
// literal: a literal here would turn every release into a failing test and
// would contradict the version the package actually declares.

test('the plugin version is a plain semantic version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'the version is MAJOR.MINOR.PATCH');
  assert.equal(pkg.name, 'dsh-cua-driver-indicator');
});

test('the README documents the version the package declares', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  // The README lists the releases newest first, so its first version heading
  // is the version of this package.
  const heading = /^>\s*\*\*(\d+\.\d+\.\d+)[：:]/m.exec(readme);
  assert.ok(heading !== null, 'the README has a version heading');
  assert.equal(heading[1], pkg.version, 'the README and the package agree on the version');
});
