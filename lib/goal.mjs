/**
 * Goal text helpers for the takeover indicator banner of dsh-cua-driver-indicator.
 *
 * Pure logic on purpose: no DSH services, no timers, no child process and no
 * import of a host SDK package, so plain node can import this file and the
 * tests can drive it directly.
 *
 * Vocabulary
 *   auto goal  — a summary of the user's latest instruction. It is the
 *                baseline: it exists without the model doing anything.
 *   model goal — a goal the model reported through the `computer_control_goal`
 *                tool. It overrides the auto goal for that session and it
 *                survives the turn it was reported in.
 *   action     — what the official desktop tool is doing. The host knows it,
 *                so it is a fact and it is never empty.
 *   identity   — who drives the desktop. The session title when that title
 *                is human wording; otherwise the kind of the session
 *                ("主会话" / "子代理" / "子代理任务"), because a machine
 *                title (an AgentTeams dispatch notice, ...) says nothing
 *                about the driver.
 *   banner     — the sentence the overlay shows:
 *                `DSH 正在控制电脑 · 会话《<会话标题>》· <动作> · 目标：<目标>`.
 */

export const DEFAULT_MAX_CHARS = 24;
export const DEFAULT_BANNER_HEAD = 'DSH 正在控制电脑';
export const DEFAULT_GOAL_TEMPLATE = '目标：{goal}';
export const MAIN_SESSION_LABEL = '主会话';
export const SUBAGENT_SESSION_LABEL = '子代理';
/**
 * The label of a child session whose title was machine text.
 *
 * An AgentTeams member gets its title from the dispatch notice that started
 * it, so the title is machine words. The banner then names the session by
 * what it is: a subagent doing a task.
 */
export const SUBAGENT_TASK_LABEL = '子代理任务';
export const DEFAULT_MAX_TITLE_CHARS = 30;

/**
 * The action word of a tool nobody mapped.
 *
 * The banner must always say something true, so an unknown tool falls back
 * to this instead of showing an English tool name or nothing at all.
 */
export const DEFAULT_ACTION_WORD = '正在操作桌面';

const GLOBAL_SESSION = 'global';
const MIN_MAX_CHARS = 4;

/**
 * Message sources that carry a real human instruction.
 *
 * DSH's `MessageSourceMap` is a merge-extensible sum type. Besides `user` it
 * also declares `model`, `tool`, `system-prompt`, `model-selection`,
 * `runtime-context`, `working-directory`, `user-approval`, `ptc-mode`,
 * `tool-registry`, `agent-message`, `subagent-settled`, `skill-invocation`,
 * `compact-checkpoint`, `cordis-host-runner`, `team-message`,
 * `user-question-reply`, `goal`, `plan-mode`, `schedule`, `session-reference`
 * and `webhook`. Every one of those also arrives as a `user/message` event
 * (a direct human prompt, an injected `agent.inject()` context, or a goal
 * continuation round), so the source is what tells them apart.
 *
 * `user-rpc` is the RPC flavour of a human prompt; in the shipped runtime it
 * carries `kind: 'user'` as well. It is listed here so a literal `user-rpc`
 * discriminant is accepted too.
 */
const HUMAN_SOURCE_KINDS = new Set(['user', 'user-rpc']);

/**
 * Openings that mark a text as machine context rather than a user prompt.
 *
 * The source kind alone is not enough: an AgentTeams task dispatch reaches the
 * subagent as a plain `user` message, so its text has to be recognized too.
 */
const MACHINE_TEXT_PREFIXES = [
  '<system-reminder',
  '<continuum_resume',
  '[MNEMON]',
  'Current runtime context',
  'Time sampled while preparing turn',
  'AgentTeams automatic task assignment',
  'Background subagent',
];

/** Fragments that mark a text as machine context wherever they appear. */
const MACHINE_TEXT_FRAGMENTS = [
  'You are executing as configured member',
  'The approval policy changed',
  'The user switched this session to plan mode',
  '[model changed',
];

/**
 * A long English-only text is machine context.
 *
 * The user of this plugin writes Chinese; a long English paragraph is almost
 * always an injected environment snapshot, a runtime context or a dispatch
 * notice rather than something the user typed.
 */
const MAX_HUMAN_WORDS = 12;

/** Remove fenced code blocks, including multi-line ones and an unclosed tail. */
function stripFences(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    // A pasted snippet that never got its closing marker: drop the remainder.
    .replace(/```[\s\S]*$/, ' ');
}

/** Collapse every run of whitespace (spaces, tabs, newlines) into one space. */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** A usable character budget: at least four, otherwise the banner reads nonsense. */
function normalizeLimit(maxChars) {
  const parsed = Number(maxChars);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CHARS;
  return Math.max(MIN_MAX_CHARS, Math.floor(parsed));
}

/** Trim a goal, mapping anything empty to null. */
function normalizeGoal(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Summarize a user instruction into a short banner-sized goal.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string|null} null when there is nothing to show
 */
export function summarizeGoal(text, maxChars = DEFAULT_MAX_CHARS) {
  if (typeof text !== 'string') return null;
  const limit = normalizeLimit(maxChars);
  const collapsed = collapseWhitespace(stripFences(text));
  if (collapsed === '') return null;
  if (collapsed.length <= limit) return collapsed;
  return collapsed.slice(0, limit - 1) + '…';
}

/**
 * Whether a text reads like something a person typed.
 *
 * The source kind of a message is the first gate, but it is not the only one:
 * an AgentTeams task dispatch reaches the subagent as a plain `user` message,
 * so the text itself has to be checked as well. Machine context never becomes
 * the banner goal.
 *
 * The rules are deliberately blunt: a known opening or fragment means "not
 * human", and a long English-only text means "not human" too.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isHumanInstructionText(text) {
  if (typeof text !== 'string') return false;
  const raw = text.trim();
  if (raw === '') return false;
  const lower = raw.toLowerCase();
  for (const prefix of MACHINE_TEXT_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) return false;
  }
  for (const fragment of MACHINE_TEXT_FRAGMENTS) {
    if (lower.includes(fragment.toLowerCase())) return false;
  }
  const collapsed = collapseWhitespace(stripFences(text));
  if (collapsed === '') return false;
  if (isPureEnglish(collapsed) && countWords(collapsed) > MAX_HUMAN_WORDS) return false;
  return true;
}

/**
 * Whether every letter in the text is an ASCII letter.
 *
 * Chinese, Japanese and Korean text is never "pure English", so the word
 * budget below only applies to English prose.
 * @param {string} text
 * @returns {boolean}
 */
function isPureEnglish(text) {
  const letters = text.match(/\p{Letter}/gu);
  if (letters === null) return false;
  return letters.every((letter) => letter.codePointAt(0) < 128);
}

/**
 * How many words the text holds; only tokens with a letter count.
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  return text.split(/\s+/).filter((token) => /\p{Letter}/u.test(token)).length;
}

/**
 * Words that mark a text as a question or a complaint rather than a task.
 *
 * A user who asks "现在配置似乎搞的有点复杂我没看懂应该怎么配置" wants an
 * answer, not that sentence in the banner: it describes the user's trouble,
 * not the work the session is doing.
 */
const NON_INSTRUCTION_WORDS = [
  '似乎',
  '好像',
  '为什么',
  '怎么',
  '怎么回事',
  '没看懂',
  '看不懂',
  '是不是',
  '能不能',
  '可不可以',
  '啊这',
];

/** A question mark, Chinese or English: a question is not a task. */
const QUESTION_MARK = /[?？]/;

/** A task needs at least this many characters to say anything at all. */
const MIN_INSTRUCTION_CHARS = 4;

/**
 * Whether a text reads like something the user wants done.
 *
 * The source kind of a message cannot tell a task from a question: both are
 * typed by the same person. A question, a complaint and a too-short remark
 * are therefore not instructions, and they must not become the goal of the
 * banner — quoting the complaint back is worse than showing no goal.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeInstruction(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_INSTRUCTION_CHARS) return false;
  if (QUESTION_MARK.test(trimmed)) return false;
  for (const word of NON_INSTRUCTION_WORDS) {
    if (trimmed.includes(word)) return false;
  }
  return true;
}

/**
 * Summarize a user instruction, but only when the text reads like human
 * wording and like a task.
 *
 * Machine text yields null instead of a fallback sentence: the banner shows
 * no goal at all rather than a slice of an environment snapshot. A question
 * or a complaint yields null for the same reason: it is not what the session
 * is doing.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string|null} null when the text is not a human instruction, or
 *   empty
 */
export function summarizeHumanGoal(text, maxChars = DEFAULT_MAX_CHARS) {
  if (!isHumanInstructionText(text)) return null;
  if (!looksLikeInstruction(text)) return null;
  return summarizeGoal(text, maxChars);
}

/**
 * Whether a session is a subagent session.
 *
 * `header.origin` is the discriminator; `header.parentSession` is not, because
 * a forked session carries one too while still being a top-level session.
 * @param {unknown} session
 * @returns {boolean}
 */
export function isSubagentSession(session) {
  return session?.header?.origin === 'subagent';
}

/**
 * Whether a session is a child session — a subagent or a derived session.
 *
 * The host records three facts about a child in its `SessionHeader`:
 *
 *   - `origin: 'subagent'` — the coarse product classification the host
 *     stamps on a session it created as a subagent child;
 *   - `delegationDepth` — the parent's depth plus one (absent or zero for a
 *     top-level session);
 *   - `parentSession` — the session this one was forked from.
 *
 * An AgentTeams member is a child session too. On the shipped host its header
 * reads `origin: 'subagent'`, `delegationDepth: 1` and the captain's session
 * id in `parentSession`. All three signals are accepted, so a host that marks
 * only one of them still identifies the session as a child.
 *
 * A user fork carries a `parentSession` too (with no `origin` and depth zero),
 * so it counts as derived as well: the banner names who drives the desktop,
 * and a fork is not the conversation the user is sitting in.
 *
 * @param {unknown} session
 * @returns {boolean}
 */
export function isDerivedSession(session) {
  const header = session?.header;
  if (!header || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  const depth = header.delegationDepth;
  if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return true;
  const parent = header.parentSession;
  return typeof parent === 'string' && parent.trim() !== '';
}

/**
 * The shortest start of a machine opening that is long enough to be
 * unambiguous. A host cuts its titles, so an opening can arrive half-way.
 */
const MACHINE_TITLE_MIN_MATCH = 12;

/** A trailing ellipsis, in either spelling. */
const TITLE_ELLIPSIS = /[.…]+$/;

/**
 * Whether a session title is machine text rather than a human title.
 *
 * The host derives a title from the session's first message. For an
 * AgentTeams member that first message is the dispatch notice, so the host
 * stores the title "AgentTeams automatic task assignment fro" — machine
 * words that belong in no banner.
 *
 * The judgement reuses the vocabulary this file already keeps: the machine
 * openings and fragments behind `isHumanInstructionText`. There is no second
 * word list. The host cuts its titles, so an opening can arrive cut in half
 * ("…assignment fro"), and the check therefore also accepts a title that
 * begins a known opening.
 *
 * @param {unknown} title
 * @returns {boolean}
 */
export function isMachineTitle(title) {
  if (typeof title !== 'string') return false;
  const raw = title.trim();
  if (raw === '') return false;
  // The existing judge answers the same question for a whole text.
  if (!isHumanInstructionText(raw)) return true;
  // The title may be cut inside a known opening.
  const lower = raw.replace(TITLE_ELLIPSIS, '').toLowerCase();
  if (lower.length < MACHINE_TITLE_MIN_MATCH) return false;
  for (const opening of MACHINE_TEXT_PREFIXES) {
    if (opening.toLowerCase().startsWith(lower)) return true;
  }
  return false;
}

/**
 * Trim a session title and shorten it for the banner.
 * @param {unknown} title
 * @param {number} maxChars
 * @returns {string|null} null when there is no usable title
 */
export function normalizeSessionTitle(title, maxChars = DEFAULT_MAX_TITLE_CHARS) {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (trimmed === '') return null;
  const limit = normalizeLimit(maxChars);
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit - 1) + '…';
}

/**
 * The identity the banner shows for a session.
 *
 * The real title wins when the host has one — but only when that title is
 * human wording. A team session gets its title from the dispatch notice that
 * started it, so the title is machine text; that text never reaches the
 * banner, and the session kind names the session instead.
 *
 * @param {unknown} session the host session
 * @param {unknown} title the title from the host's session-title service
 * @param {number} maxChars
 * @returns {string} never empty
 */
export function sessionLabel(session, title, maxChars = DEFAULT_MAX_TITLE_CHARS) {
  const derived = isDerivedSession(session);
  // A machine title is not an identity: it is the dispatch notice of a team
  // task (or any other machine context) and it says nothing about who drives
  // the desktop. The session kind does.
  if (isMachineTitle(title)) {
    return derived ? SUBAGENT_TASK_LABEL : MAIN_SESSION_LABEL;
  }
  const normalized = normalizeSessionTitle(title, maxChars);
  if (normalized !== null) return normalized;
  return derived ? SUBAGENT_SESSION_LABEL : MAIN_SESSION_LABEL;
}

/**
 * The tool-name prefix of the official built-in Cua Driver channel.
 *
 * The action table is keyed by the bare tool name, so a caller may hand over
 * either the bare name or the full one.
 */
const OFFICIAL_TOOL_PREFIX = 'cua_driver_native__';

/**
 * Bare official tool name -> the Chinese action word the banner shows.
 *
 * The host knows which official tool is running, so this segment is a fact
 * rather than a guess: it always says something true, and it is the one part
 * of the banner that is always there.
 */
const ACTION_WORDS = new Map([
  // Reading the screen.
  ['get_desktop_state', '正在看屏幕'],
  ['get_window_state', '正在看屏幕'],
  ['get_accessibility_tree', '正在看屏幕'],
  ['get_screenshot', '正在看屏幕'],
  ['get_screen_size', '正在看屏幕'],
  ['get_cursor_position', '正在看屏幕'],
  ['get_agent_cursor_state', '正在看屏幕'],
  ['zoom', '正在看屏幕'],
  ['verify_state', '正在看屏幕'],
  // Pointing at things.
  ['click', '正在点击'],
  ['double_click', '正在点击'],
  ['right_click', '正在点击'],
  ['invoke_menu', '正在点击'],
  // Writing.
  ['type_text', '正在输入'],
  ['set_value', '正在输入'],
  ['insert_text', '正在输入'],
  // Keys.
  ['press_key', '正在按键'],
  ['hotkey', '正在按键'],
  // Scrolling and dragging.
  ['scroll', '正在滚动'],
  ['drag', '正在拖拽'],
  // Starting and closing things.
  ['launch_app', '正在启动程序'],
  ['open', '正在启动程序'],
  ['kill_app', '正在关闭程序'],
  ['end_session', '正在结束控制'],
  // Read-only queries about the desktop.
  ['list_windows', '正在查看窗口'],
  ['list_apps', '正在查看窗口'],
  ['get_config', '正在查看窗口'],
  ['debug_window_info', '正在查看窗口'],
  // The pointer itself.
  ['move', '正在移动鼠标'],
  ['move_cursor', '正在移动鼠标'],
  // Windows and windows.
  ['bring_to_front', '正在切换窗口'],
  ['set_window_frame', '正在调整窗口'],
  // Recording the screen.
  ['start_recording', '正在录制屏幕'],
  ['stop_recording', '正在录制屏幕'],
  // The clipboard.
  ['clipboard_read', '正在操作剪贴板'],
  ['clipboard_write', '正在操作剪贴板'],
  ['set_clipboard', '正在操作剪贴板'],
  // The browser channel.
  ['browser_prepare', '正在操作浏览器'],
  ['browser_navigate', '正在操作浏览器'],
  ['browser_click', '正在操作浏览器'],
  ['browser_type', '正在操作浏览器'],
  ['browser_pointer', '正在操作浏览器'],
  ['browser_dialog', '正在操作浏览器'],
  ['browser_download', '正在操作浏览器'],
  ['browser_set_input_files', '正在操作浏览器'],
  ['get_browser_state', '正在操作浏览器'],
  ['page', '正在操作浏览器'],
]);

/**
 * The action word of an official desktop tool.
 *
 * A tool nobody mapped falls back to `DEFAULT_ACTION_WORD`: the banner never
 * shows an English tool name and never leaves the segment empty.
 *
 * @param {unknown} toolName the tool name, bare or with the official prefix
 * @returns {string} never empty
 */
export function actionWordFor(toolName) {
  if (typeof toolName !== 'string') return DEFAULT_ACTION_WORD;
  const trimmed = toolName.trim();
  if (trimmed === '') return DEFAULT_ACTION_WORD;
  const bare = trimmed.startsWith(OFFICIAL_TOOL_PREFIX) ? trimmed.slice(OFFICIAL_TOOL_PREFIX.length) : trimmed;
  return ACTION_WORDS.get(bare) ?? DEFAULT_ACTION_WORD;
}

/**
 * Build the banner sentence.
 *
 * The sentence names who is driving the desktop, what is being done right now
 * and, when there is one, what the goal is. The action segment is always
 * there — it is a fact about the running tool. A missing goal drops its whole
 * segment instead of leaving an empty "目标：" behind.
 *
 * @param {string} head the leading text, e.g. `DSH 正在控制电脑`
 * @param {string} label the session identity, e.g. `《标题》`'s inner text
 * @param {string|null|undefined} goal the current goal
 * @param {string} goalTemplate the goal segment template, `{goal}` is replaced
 * @param {string} action the action word of the running tool
 * @returns {string}
 */
export function composeBannerText(
  head,
  label,
  goal,
  goalTemplate = DEFAULT_GOAL_TEMPLATE,
  action = DEFAULT_ACTION_WORD,
) {
  const headText = typeof head === 'string' && head.trim() !== '' ? head.trim() : DEFAULT_BANNER_HEAD;
  const identity = typeof label === 'string' && label.trim() !== '' ? label.trim() : MAIN_SESSION_LABEL;
  const actionText = typeof action === 'string' && action.trim() !== '' ? action.trim() : DEFAULT_ACTION_WORD;
  let text = `${headText} · 会话《${identity}》· ${actionText}`;
  const summary = normalizeGoal(goal);
  if (summary === null) return text;
  const pattern = typeof goalTemplate === 'string' && goalTemplate !== '' ? goalTemplate : DEFAULT_GOAL_TEMPLATE;
  // A function replacer keeps a `$&` inside the goal from being interpreted.
  const segment = pattern.includes('{goal}') ? pattern.replace('{goal}', () => summary) : pattern + summary;
  return `${text} · ${segment}`;
}

/**
 * Per-session goal state. The model goal wins over the auto goal; a fresh
 * instruction drops the model goal because it describes the previous task.
 */
export class GoalStore {
  constructor() {
    /** @type {Map<string, {model: string|null, auto: string|null}>} */
    this.sessions = new Map();
  }

  /** Session bucket key; unknown sessions share the `global` bucket. */
  key(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId;
    if (typeof sessionId === 'number' && Number.isFinite(sessionId)) return String(sessionId);
    return GLOBAL_SESSION;
  }

  entry(sessionId) {
    const key = this.key(sessionId);
    let entry = this.sessions.get(key);
    if (entry === undefined) {
      entry = { model: null, auto: null };
      this.sessions.set(key, entry);
    }
    return entry;
  }

  /** Read a bucket without creating one: a lookup must not grow the map. */
  peek(sessionId) {
    return this.sessions.get(this.key(sessionId)) ?? { model: null, auto: null };
  }

  /** Record the goal the model reported for a session. */
  setModelGoal(sessionId, goal) {
    const entry = this.entry(sessionId);
    entry.model = normalizeGoal(goal);
    return entry.model;
  }

  /**
   * Whether the model reported a goal for this session.
   *
   * The automatic summary of the user's instruction does not count: the gate
   * asks for a goal the model declared on purpose, because only the model
   * knows what it is about to do.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasModelGoal(sessionId) {
    return this.peek(sessionId).model !== null;
  }

  /**
   * Record the automatic summary of the latest instruction.
   * The model goal is dropped: a new instruction means a new goal.
   */
  setAutoGoal(sessionId, summary) {
    const entry = this.entry(sessionId);
    entry.auto = normalizeGoal(summary);
    entry.model = null;
    return entry.auto;
  }

  /**
   * Drop only the model goal, keeping the automatic summary.
   *
   * The plugin does not call this when a turn ends: a goal the model
   * declared describes the work of the session, not of one turn, so it stays
   * until the session is gone or a new instruction arrives.
   */
  clearModelGoal(sessionId) {
    this.entry(sessionId).model = null;
  }

  /**
   * Forget a session completely.
   * The host process is long-lived, so ended sessions must not pile up.
   * @returns {boolean} whether a bucket was actually removed
   */
  delete(sessionId) {
    return this.sessions.delete(this.key(sessionId));
  }

  /** The goal that should be shown for a session. */
  forSession(sessionId) {
    const entry = this.peek(sessionId);
    return entry.model ?? entry.auto ?? null;
  }

  /** Both slots of one session, for inspection and tests. */
  entryFor(sessionId) {
    const entry = this.peek(sessionId);
    return { model: entry.model, auto: entry.auto };
  }
}

// --- The gate in front of the desktop --------------------------------------------
//
// Before the desktop is touched at all, the model has to say what it is about
// to do: that sentence is what the user reads while the desktop is being
// controlled. The rules live here as plain functions, so the tests can pin
// them without a host and the plugin cannot keep a second copy of them.

/** The gate lets the desktop call through. */
export const GATE_ALLOW = 'allow';

/** The gate sends the desktop call back so the model can declare its goal. */
export const GATE_BLOCK = 'block';

/**
 * The decision of the goal gate for one desktop call.
 *
 * - a goal the model declared always wins: the model said what it is about to
 *   do, and the banner can show it;
 * - without one, the first call of a turn is sent back with an error the
 *   model can act on: declare the goal, then retry the same call;
 * - the retry inside the same turn is let through, so a model that ignores the
 *   request is never locked out of the desktop.
 *
 * @param {boolean} hasDeclaredGoal whether the model declared a goal
 * @param {boolean} alreadyBlocked whether this (session, turn) was already sent back
 * @returns {'allow'|'block'}
 */
export function decideGoalGate(hasDeclaredGoal, alreadyBlocked) {
  if (hasDeclaredGoal === true) return GATE_ALLOW;
  if (alreadyBlocked === true) return GATE_ALLOW;
  return GATE_BLOCK;
}

/**
 * The gate state of one session: the turns that were already sent back.
 *
 * Plain data, so the rule can be tested without a host. A turn is remembered
 * only inside that turn: the block of one turn never leaks into the next one.
 *
 * @param {string} sessionId the session the state belongs to
 * @returns {{sessionId: string, blockedTurns: string[]}}
 */
export function createGateState(sessionId) {
  return { sessionId: String(sessionId), blockedTurns: [] };
}

/**
 * Whether this turn of this session was already sent back by the gate.
 *
 * @param {{blockedTurns?: readonly string[]}|null|undefined} state
 * @param {number|string} turn
 * @returns {boolean}
 */
export function gateStateBlocks(state, turn) {
  if (!state || !Array.isArray(state.blockedTurns)) return false;
  return state.blockedTurns.includes(String(turn));
}

/**
 * The state after a call that was sent back: this turn joins the list.
 *
 * The state is never mutated — a new one comes back — so the rule stays a
 * plain function. A turn that is on the list already is not added twice.
 *
 * @param {{sessionId: string, blockedTurns?: readonly string[]}} state
 * @param {number|string} turn
 * @returns {{sessionId: string, blockedTurns: string[]}}
 */
export function nextGateState(state, turn) {
  const key = String(turn);
  const blockedTurns = Array.isArray(state?.blockedTurns) ? [...state.blockedTurns] : [];
  if (!blockedTurns.includes(key)) blockedTurns.push(key);
  return { sessionId: state?.sessionId ?? '', blockedTurns };
}

/**
 * Whether a session has a goal the model declared.
 *
 * Only a declared goal counts: the automatic summary of the user's
 * instruction says what the user asked for, not what the model is about to
 * do. The automatic summary must never open the gate.
 *
 * The goal is stored under the id of the session, and that is the key that is
 * looked up first. The id of the agent is only a second chance, so a goal
 * declared by a host that names the agent apart from its session still counts.
 *
 * @param {{hasModelGoal: (sessionId: unknown) => boolean}} store the goal store
 * @param {unknown} sessionId the id of the session
 * @param {unknown} agentId the id of the calling agent
 * @returns {boolean}
 */
export function hasDeclaredGoal(store, sessionId, agentId) {
  if (store.hasModelGoal(sessionId)) return true;
  if (typeof agentId === 'string' && agentId !== '' && agentId !== sessionId && store.hasModelGoal(agentId)) return true;
  return false;
}

/**
 * The key the goal of a session is stored under.
 *
 * The banner reads the goal under the id of the session that holds the
 * desktop lease, so the store uses that very key: the id of the session. The
 * id of the agent is only the fallback for a host that does not name the
 * session at all — today both ids are the same, but the banner must not
 * depend on that, or a host that names them apart would silently fall back
 * to the automatic summary.
 *
 * @param {unknown} sessionId the id of the session
 * @param {unknown} agentId the id of the calling agent
 * @returns {string}
 */
export function goalStoreKey(sessionId, agentId) {
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId;
  if (typeof agentId === 'string' && agentId !== '') return agentId;
  return GLOBAL_SESSION;
}

/**
 * The gate state of every session: the turns that were already sent back.
 *
 * @typedef {Map<string, {sessionId: string, blockedTurns: string[]}>} GateStates
 */

/**
 * The key the gate state of a session is stored under.
 *
 * One entry point for both sides of the gate: the gate writes the state under
 * this key, and the plugin forgets it under the very same key. Two places
 * that each computed the key could drift apart, and the state would survive
 * a turn it should not — or be forgotten while it should still count.
 *
 * @param {unknown} sessionId the id of the session
 * @param {unknown} agentId the id of the calling agent
 * @returns {string}
 */
export function gateStateKey(sessionId, agentId) {
  return goalStoreKey(sessionId, agentId);
}

/**
 * The turn a host tool execution runs in.
 *
 * The host names the turn through the phase of the agent: a call that does
 * not run inside a running turn has none. The rule lives here, next to the
 * gate that uses it, so the plugin and the gate cannot disagree about which
 * turn a call belongs to.
 *
 * The value is handed on as the host gave it — including a missing one. The
 * gate checks it and fails open when it is unusable; hiding the problem here
 * would only move it.
 *
 * @param {unknown} exec the tool execution
 * @returns {number|string|undefined} undefined when the call runs in no turn
 */
export function execTurn(exec) {
  const phase = exec?.agent?.phase;
  if (!phase || phase.kind !== 'running') return undefined;
  return phase.turn;
}

/**
 * Whether a turn can tell one call from another.
 *
 * A turn is only usable when it names something: a number or a non-empty
 * string. `undefined` and `null` are not turns — they would be turned into
 * the string 'undefined' and every missing turn would look like the same
 * one.
 *
 * @param {unknown} turn
 * @returns {boolean}
 */
function isUsableTurn(turn) {
  if (typeof turn === 'number') return Number.isFinite(turn);
  if (typeof turn === 'string') return turn !== '';
  return false;
}

/**
 * Evaluate the goal gate for one desktop call.
 *
 * `decideGoalGate` pins the rule, but the rule is not the whole gate: the gate
 * also has to read the declared goal and read the block record of *this* turn.
 * That wiring used to live in lib/index.js, where no test can reach it — a
 * mistake there (a hard-coded `alreadyBlocked`, a lost turn) left the whole
 * suite green while the gate degraded into a permanent block. Here the wiring
 * is one pure function, so those mistakes are test cases instead of surprises
 * at the desktop.
 *
 * The function reads the state container but never writes to it: `nextState`
 * is the state the caller should store when the call was sent back, and the
 * unchanged current state when the call was let through. `runGoalGate` is the
 * one that writes it.
 *
 * A call without a usable turn is let through on purpose. The gate cannot
 * tell the first call of a turn from the retry inside it, and refusing such a
 * call would lock the desktop out for good — a gate that never opens is worse
 * than no gate. The caller is told about it through `missingTurn`.
 *
 * @param {{hasModelGoal: (sessionId: unknown) => boolean}} store the goal store
 * @param {GateStates|null|undefined} states the gate state of every session
 * @param {{sessionId: unknown, agentId?: unknown, turn?: number|string|null}} context
 *   the ids of the call and the turn it runs in
 * @returns {{decision: 'allow'|'block', declared: boolean, alreadyBlocked: boolean,
 *   nextState: {sessionId: string, blockedTurns: string[]}, stateKey: string,
 *   missingTurn: boolean}}
 *   the decision, the two facts it was made of, the state to store afterwards,
 *   the key it belongs under and whether the turn was missing
 */
export function evaluateGoalGate(store, states, context) {
  const sessionId = context?.sessionId;
  const agentId = context?.agentId;
  const turn = context?.turn;
  // Only a declared goal counts: the automatic summary of the user's
  // instruction says what the user asked for, not what the model is about to
  // do.
  const declared = hasDeclaredGoal(store, sessionId, agentId);
  const stateKey = gateStateKey(sessionId, agentId);
  const state = states?.get?.(stateKey) ?? createGateState(stateKey);
  if (!isUsableTurn(turn)) {
    // No usable turn: fail open rather than lock the desktop out.
    return {
      decision: GATE_ALLOW,
      declared,
      alreadyBlocked: false,
      nextState: state,
      stateKey,
      missingTurn: true,
    };
  }
  const alreadyBlocked = gateStateBlocks(state, turn);
  const decision = decideGoalGate(declared, alreadyBlocked);
  // A call that was sent back joins the block record, so the retry inside the
  // same turn is let through. A call that was let through leaves the record
  // alone.
  const nextState = decision === GATE_BLOCK ? nextGateState(state, turn) : state;
  return { decision, declared, alreadyBlocked, nextState, stateKey, missingTurn: false };
}

/**
 * Run the goal gate for one desktop call and remember the turn it sent back.
 *
 * This is the unit the plugin calls. It evaluates the gate and, when the call
 * was sent back, it writes the block record into the state container itself.
 * The plugin only reads the decision — it never writes the state — so the
 * "remember this turn" step lives inside the tested unit instead of beside
 * it, where a mistake would stay invisible to the whole suite.
 *
 * A call that was let through leaves the container alone.
 *
 * @param {{hasModelGoal: (sessionId: unknown) => boolean}} store the goal store
 * @param {GateStates|null|undefined} states the gate state of every session
 * @param {{sessionId: unknown, agentId?: unknown, turn?: number|string|null}} context
 *   the ids of the call and the turn it runs in
 * @returns {{decision: 'allow'|'block', declared: boolean, alreadyBlocked: boolean,
 *   stateKey: string, recorded: boolean, missingTurn: boolean,
 *   state: {sessionId: string, blockedTurns: string[]}|null}}
 *   the decision, the facts it was made of, the key it belongs under, whether
 *   the turn was recorded, whether the turn was missing and the state the
 *   container holds now
 */
export function runGoalGate(store, states, context) {
  const evaluation = evaluateGoalGate(store, states, context);
  if (evaluation.decision !== GATE_BLOCK) {
    // Nothing was sent back, so nothing is remembered: the container keeps
    // whatever it held.
    return {
      ...evaluation,
      recorded: false,
      state: states?.get?.(evaluation.stateKey) ?? null,
    };
  }
  if (typeof states?.set !== 'function') {
    // There is nowhere to remember the block, so the next call of the same
    // turn would be sent back again, and the one after that. The gate fails
    // open instead: the desktop stays usable.
    return { ...evaluation, decision: GATE_ALLOW, recorded: false, state: null };
  }
  states.set(evaluation.stateKey, evaluation.nextState);
  return { ...evaluation, recorded: true, state: evaluation.nextState };
}

/** Collect text out of one message fragment. */
function collectText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const part = collectText(item);
      if (typeof part === 'string' && part.trim() !== '') parts.push(part.trim());
    }
    return parts.join(' ');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined && value.content !== null) return collectText(value.content);
  }
  return '';
}

/**
 * Pull the user text out of whatever shape the message arrived in.
 * @param {unknown} data
 * @returns {string|null} null when there is no readable text
 */
export function extractUserText(data) {
  if (data === undefined || data === null) return null;
  const text = collectText(data);
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Whether a `user/message` payload is a real human instruction.
 *
 * Injected context (runtime-context snapshots, working directory, tool
 * registry, cron notices, goal continuations, ...) is delivered through the
 * same event, so the source kind is the only reliable discriminator.
 * @param {unknown} data the `user/message` event payload
 * @returns {boolean}
 */
export function isHumanInstruction(data) {
  if (!data || typeof data !== 'object') return false;
  const kind = data.source?.kind;
  return typeof kind === 'string' && HUMAN_SOURCE_KINDS.has(kind);
}

/**
 * The most recent human instruction in a session's event history, as a goal.
 *
 * The plugin only sees the events that arrive while it is mounted, so a
 * session that already existed when DSH started has no recorded goal and the
 * banner would show the plain fallback text. This reads the session's own
 * event log and turns the latest real instruction into a banner-sized goal.
 *
 * Injected context shares the `user/message` event with real prompts, so two
 * gates apply: the source kind has to be a human one, and the text itself has
 * to read like human wording. A dispatch notice that arrives as a `user`
 * message is therefore skipped in favour of an earlier instruction.
 *
 * @param {readonly {type?: string, data?: unknown}[]} events session events, oldest first
 * @param {number} maxChars
 * @returns {string|null} null when the history holds no human instruction
 */
export function latestHumanGoal(events, maxChars = DEFAULT_MAX_CHARS) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;
    if (event.type !== 'user/message') continue;
    if (!isHumanInstruction(event.data)) continue;
    const summary = summarizeHumanGoal(extractUserText(event.data), maxChars);
    if (summary !== null) return summary;
  }
  return null;
}

/**
 * Whether a session's goal may be recovered from its own event history.
 *
 * The recovered goal is a fallback: it fills a session that has none and
 * never replaces one that has. A goal the model reported through
 * `computer_control_goal` and the summary of a live instruction both
 * outrank it.
 *
 * @param {string|null|undefined} existingGoal the goal the session already has
 * @returns {boolean}
 */
export function shouldBackfillGoal(existingGoal) {
  return existingGoal === null || existingGoal === undefined;
}

/**
 * The goal a session should show, recovered from its own history when it has
 * none.
 *
 * @param {string|null|undefined} existingGoal the goal the session already has
 * @param {readonly {type?: string, data?: unknown}[]|null|undefined} events the session's own events
 * @param {number} maxChars
 * @returns {{goal: string|null, recovered: boolean}} the goal to show, and
 *   whether it came from the history
 */
export function resolveBackfillGoal(existingGoal, events, maxChars = DEFAULT_MAX_CHARS) {
  if (!shouldBackfillGoal(existingGoal)) return { goal: existingGoal, recovered: false };
  const goal = latestHumanGoal(events, maxChars);
  if (goal === null) return { goal: null, recovered: false };
  return { goal, recovered: true };
}

/**
 * Recover a goal for a session that has none, from its own event history.
 *
 * This is the one place that decides whether a recovered goal may be stored,
 * so the two rules it protects cannot drift apart: a session that already
 * has a goal keeps it — the model's report and the summary of a live
 * instruction both outrank the recovered one — and a session without one
 * gets the latest human instruction from its history.
 *
 * @param {GoalStore} store the goal store to write into
 * @param {string} sessionId the session to fill
 * @param {readonly {type?: string, data?: unknown}[]|null|undefined} events the session's own events
 * @param {number} maxChars
 * @returns {string|null} the recovered goal, or null when there was none
 */
export function backfillGoalFrom(store, sessionId, events, maxChars = DEFAULT_MAX_CHARS) {
  const existing = store.forSession(sessionId);
  if (!shouldBackfillGoal(existing)) return null;
  const resolved = resolveBackfillGoal(existing, events, maxChars);
  if (!resolved.recovered) return null;
  store.setAutoGoal(sessionId, resolved.goal);
  return resolved.goal;
}

/**
 * Whether a session's own history should be scanned again.
 *
 * A scan that failed left no trace, so the next desktop call tries again. A
 * scan that succeeded is not repeated until the session's history grew,
 * because an unchanged history yields the same answer.
 *
 * @param {number|null|undefined} scannedLength the history length seen by the
 *   last successful scan, or undefined when there was none
 * @param {number|null|undefined} currentLength the session's current history length
 * @returns {boolean}
 */
export function shouldRescanHistory(scannedLength, currentLength) {
  // No successful scan yet, or the last attempt failed: try again.
  if (scannedLength === undefined) return true;
  // The length cannot be measured, so a growth cannot be detected. Do not
  // turn every desktop call into a scan.
  if (scannedLength === null || currentLength === null || currentLength === undefined) return false;
  return currentLength !== scannedLength;
}
