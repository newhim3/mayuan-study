const STORAGE_KEY = "mayuan-study-v1";

const state = {
  questions: [],
  usableQuestions: [],
  reliableQuestions: [],
  session: [],
  sessionIndex: 0,
  sessionLabel: "顺序练习",
  examMode: false,
  examSubmitted: false,
  examPaper: null,
  examAnswers: {},
  examScore: null,
  selected: new Set(),
  revealed: false,
  deferredInstall: null,
  records: {},
  favorites: [],
  lastQuestionId: null,
  theme: "light",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function loadLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.records = saved.records || {};
    state.favorites = saved.favorites || [];
    state.lastQuestionId = saved.lastQuestionId || null;
    state.theme = saved.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch {
    state.records = {};
    state.favorites = [];
  }
  document.documentElement.dataset.theme = state.theme;
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    records: state.records,
    favorites: state.favorites,
    lastQuestionId: state.lastQuestionId,
    theme: state.theme,
  }));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 1800);
}

function formatChapter(chapter) {
  return chapter === "未分类" ? "来源未归章" : chapter;
}

function showView(viewName) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${viewName}-view`));
  $$(".bottom-nav button").forEach((button) => button.classList.toggle("active", button.dataset.tab === viewName));
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("#main").focus({ preventScroll: true });
}

function questionRecord(id) {
  return state.records[id] || { attempts: 0, correctCount: 0, lastCorrect: null, lastAnswer: [], lastAt: null };
}

function isFavorite(id) {
  return state.favorites.includes(id);
}

function answeredQuestions() {
  return state.reliableQuestions.filter((question) => questionRecord(question.id).attempts > 0);
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function calculateStreak() {
  const days = new Set(Object.values(state.records).filter((record) => record.lastAt).map((record) => record.lastAt.slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function updateDashboard() {
  const total = state.reliableQuestions.length;
  const answered = answeredQuestions();
  const wrong = state.usableQuestions.filter((question) => questionRecord(question.id).lastCorrect === false);
  const favorites = state.usableQuestions.filter((question) => isFavorite(question.id));
  const totalAttempts = Object.values(state.records).reduce((sum, record) => sum + (record.attempts || 0), 0);
  const correctAttempts = Object.values(state.records).reduce((sum, record) => sum + (record.correctCount || 0), 0);
  const progress = total ? Math.round((answered.length / total) * 100) : 0;
  const today = Object.values(state.records).filter((record) => record.lastAt?.slice(0, 10) === todayKey()).length;

  $("#bank-count").textContent = `${total.toLocaleString()} 道已校验题目`;
  $("#completed-count").textContent = answered.length.toLocaleString();
  $("#progress-percent").textContent = `${progress}%`;
  $("#progress-ring").style.setProperty("--progress", progress);
  $("#progress-summary").textContent = answered.length
    ? `已覆盖题库的 ${progress}%，还有 ${(total - answered.length).toLocaleString()} 道等待完成。`
    : "还没有答题记录，今天从第一题开始。";
  $("#today-count").textContent = today;
  $("#accuracy-count").textContent = totalAttempts ? Math.round((correctAttempts / totalAttempts) * 100) : "--";
  $("#streak-count").textContent = calculateStreak();
  $("#wrong-mode-count").textContent = wrong.length ? `${wrong.length} 道需要巩固` : "暂无错题";
  $("#favorite-mode-count").textContent = favorites.length ? `已收藏 ${favorites.length} 道` : "尚未收藏";
  const machineCount = state.usableQuestions.filter((question) => question.machineExam).length;
  $("#machine-mode-count").textContent = `${machineCount} 道机考来源题`;
  renderMockPapers();
  renderChapters();
}

function renderMockPapers() {
  const papers = new Map();
  state.usableQuestions.forEach((question) => {
    (question.mockPapers || []).forEach((paper) => {
      if (!papers.has(paper)) papers.set(paper, []);
      papers.get(paper).push(question);
    });
  });
  const sorted = [...papers.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN", { numeric: true }));
  $("#mock-list").innerHTML = sorted.map(([paper, questions], index) => `<button class="mock-card" data-paper="${escapeHtml(paper)}">
    <span>模拟卷 ${String(index + 1).padStart(2, "0")}</span>
    <strong>${escapeHtml(paper)}</strong>
    <small>${questions.length} 道可用题 · 交卷后统一判分</small>
  </button>`).join("");
}

function renderChapters() {
  const chapters = new Map();
  state.reliableQuestions.forEach((question) => {
    if (!chapters.has(question.chapter)) chapters.set(question.chapter, []);
    chapters.get(question.chapter).push(question);
  });
  const preferred = ["导论", "第一章", "第二章", "第三章", "第四章", "第五章", "第六章", "第七章", "未分类"];
  const rank = (chapter) => preferred.findIndex((prefix) => chapter.startsWith(prefix));
  const sorted = [...chapters.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], "zh-CN"));
  $("#chapter-list").innerHTML = sorted.map(([chapter, questions]) => {
    const done = questions.filter((question) => questionRecord(question.id).attempts > 0).length;
    const percent = Math.round((done / questions.length) * 100);
    return `<button class="chapter-row" data-chapter="${escapeHtml(chapter)}">
      <span class="chapter-title"><strong>${escapeHtml(formatChapter(chapter))}</strong><small>${done} / ${questions.length} 题</small></span>
      <span class="mini-progress"><span style="width:${percent}%"></span></span>
      <span class="chapter-percent">${percent}%</span>
    </button>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function questionTypeRank(question) {
  if (question.type === "single") return 0;
  if (question.type === "true_false") return 1;
  return 2;
}

function groupByQuestionType(items) {
  return [...items].sort((left, right) => questionTypeRank(left) - questionTypeRank(right));
}

function startSession(mode, chapter = null, focusId = null) {
  let questions = state.reliableQuestions;
  let label = "顺序练习";
  state.examMode = false;
  state.examSubmitted = false;
  state.examPaper = null;
  state.examAnswers = {};
  state.examScore = null;
  if (chapter) {
    questions = questions.filter((question) => question.chapter === chapter);
    label = formatChapter(chapter);
  } else if (mode === "random") {
    questions = shuffled(questions);
    label = "随机练习";
  } else if (mode === "wrong") {
    questions = state.usableQuestions.filter((question) => questionRecord(question.id).lastCorrect === false);
    label = "错题重练";
  } else if (mode === "favorites") {
    questions = state.usableQuestions.filter((question) => isFavorite(question.id));
    label = "收藏练习";
  } else if (mode === "machine") {
    questions = state.usableQuestions.filter((question) => question.machineExam);
    label = "机考重点";
  } else if (mode === "continue") {
    label = "继续练习";
  }

  questions = groupByQuestionType(questions);

  if (!questions.length) {
    showToast(mode === "wrong" ? "还没有错题" : mode === "favorites" ? "还没有收藏题目" : "这个集合暂时没有可用题目");
    return;
  }
  state.session = questions;
  state.sessionLabel = label;
  state.sessionIndex = Math.max(0, focusId ? questions.findIndex((question) => question.id === focusId) : mode === "continue" && state.lastQuestionId ? questions.findIndex((question) => question.id === state.lastQuestionId) : 0);
  if (state.sessionIndex < 0) state.sessionIndex = 0;
  renderQuestion();
  showView("practice");
}

function startMockPaper(paper) {
  const questions = state.usableQuestions
    .filter((question) => (question.mockPapers || []).includes(paper))
    .sort((left, right) => questionTypeRank(left) - questionTypeRank(right)
      || (left.mockOrder?.[paper] ?? 99999) - (right.mockOrder?.[paper] ?? 99999));
  if (!questions.length) {
    showToast("这套试卷暂时没有已校验题目");
    return;
  }
  state.session = questions;
  state.sessionIndex = 0;
  state.sessionLabel = paper;
  state.examMode = true;
  state.examSubmitted = false;
  state.examPaper = paper;
  state.examAnswers = {};
  state.examScore = null;
  renderQuestion();
  showView("practice");
}

function currentQuestion() {
  return state.session[state.sessionIndex];
}

function renderQuestion() {
  const question = currentQuestion();
  if (!question) return;
  state.selected = new Set(state.examMode ? (state.examAnswers[question.id] || []) : []);
  state.revealed = state.examMode && state.examSubmitted;
  if (!state.examMode) {
    state.lastQuestionId = question.id;
    saveLocalState();
  }
  const record = questionRecord(question.id);
  const multi = question.type === "multiple";
  const progress = ((state.sessionIndex + 1) / state.session.length) * 100;
  $("#practice-label").textContent = state.examSubmitted && state.examScore
    ? `${state.sessionLabel} · ${state.examScore.correct}/${state.examScore.total}`
    : state.sessionLabel;
  $("#question-position").textContent = `${state.sessionIndex + 1} / ${state.session.length}`;
  $("#practice-progress-bar").style.width = `${progress}%`;
  const typeKind = multi ? "multiple" : question.type === "true_false" ? "true-false" : "single";
  const typeLabel = multi ? "多选题 · 可多选" : question.type === "true_false" ? "判断题 · 选一项" : "单选题 · 选一项";
  const typeChip = $("#question-type");
  typeChip.dataset.type = typeKind;
  typeChip.textContent = question.machineExam && !state.examMode ? `机考重点 · ${typeLabel}` : typeLabel;
  $("#question-chapter").textContent = question.chapter === "未分类"
    ? (state.examMode ? "模拟测试来源" : question.machineExam ? "机考来源" : "来源未归章")
    : formatChapter(question.chapter);
  $("#question-title").textContent = question.stem;
  $("#multiple-hint").classList.add("hidden");
  const favorite = isFavorite(question.id);
  $("#favorite-button").setAttribute("aria-pressed", favorite);
  $("#favorite-button span").textContent = favorite ? "★" : "☆";
  if (state.examMode) {
    const history = $("#history-status");
    history.className = "history-status";
    if (state.examSubmitted) {
      const selected = (state.examAnswers[question.id] || []).sort().join("");
      const correct = selected === question.answer;
      history.classList.add(correct ? "correct" : "wrong");
      history.textContent = selected ? `你的答案 ${selected} · ${correct ? "回答正确" : `正确答案 ${question.answer}`}` : `本题未作答 · 正确答案 ${question.answer}`;
    } else {
      history.textContent = state.selected.size ? "模拟测试进行中 · 本题已保存答案" : "模拟测试进行中 · 交卷前不显示答案和解析";
    }
  } else {
    updateHistoryStatus(record);
  }
  $("#options").innerHTML = Object.entries(question.options).map(([letter, text]) => {
    const selected = state.selected.has(letter);
    const classes = ["option-button"];
    if (selected) classes.push("selected");
    if (state.revealed && question.answer.includes(letter)) classes.push("correct");
    else if (state.revealed && selected) classes.push("wrong");
    return `<button class="${classes.join(" ")}" data-option="${letter}" aria-pressed="${selected}" ${state.revealed ? "disabled" : ""}><span class="option-letter">${letter}</span><span>${escapeHtml(text)}</span></button>`;
  }).join("");
  const panel = $("#result-panel");
  if (state.revealed) {
    const selected = [...state.selected].sort().join("");
    const correct = selected === question.answer;
    panel.className = `result-panel${correct ? "" : " wrong"}`;
    panel.innerHTML = `<strong>${correct ? "回答正确" : `${selected ? `你的答案 ${selected}` : "未作答"} · 正确答案 ${question.answer}`}</strong><p>${escapeHtml(question.explanation)}</p>`;
  } else {
    panel.className = "result-panel hidden";
    panel.innerHTML = "";
  }
  if (state.examMode) {
    $("#submit-button").textContent = state.examSubmitted ? "已交卷" : state.sessionIndex === state.session.length - 1 ? "交卷" : "保存并下一题";
    $("#submit-button").disabled = state.examSubmitted;
  } else {
    $("#submit-button").textContent = "提交答案";
    $("#submit-button").disabled = false;
  }
  $("#previous-button").disabled = state.sessionIndex === 0;
  $("#next-button").disabled = state.sessionIndex === state.session.length - 1;
  renderNavigator();
}

function updateHistoryStatus(record) {
  const element = $("#history-status");
  element.className = "history-status";
  if (!record.attempts) {
    element.textContent = "本题尚未作答";
    return;
  }
  element.classList.add(record.lastCorrect ? "correct" : "wrong");
  element.textContent = `已做 ${record.attempts} 次 · 答对 ${record.correctCount} 次 · 最近一次${record.lastCorrect ? "正确" : "错误"}`;
}

function chooseOption(letter) {
  if (state.revealed) return;
  const question = currentQuestion();
  if (question.type === "multiple") {
    state.selected.has(letter) ? state.selected.delete(letter) : state.selected.add(letter);
  } else {
    state.selected = new Set([letter]);
  }
  $$(".option-button").forEach((button) => {
    const selected = state.selected.has(button.dataset.option);
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected);
  });
}

function submitAnswer() {
  const question = currentQuestion();
  if (state.examMode && !state.examSubmitted) {
    submitExamAnswer();
    return;
  }
  if (!question || state.revealed) {
    if (state.sessionIndex < state.session.length - 1) goToQuestion(state.sessionIndex + 1);
    return;
  }
  if (!state.selected.size) {
    showToast("请先选择答案");
    return;
  }
  const selected = [...state.selected].sort().join("");
  const correct = selected === question.answer;
  const previous = questionRecord(question.id);
  state.records[question.id] = {
    attempts: previous.attempts + 1,
    correctCount: previous.correctCount + (correct ? 1 : 0),
    lastCorrect: correct,
    lastAnswer: [...state.selected].sort(),
    lastAt: new Date().toISOString(),
  };
  state.revealed = true;
  saveLocalState();

  $$(".option-button").forEach((button) => {
    const letter = button.dataset.option;
    button.disabled = true;
    if (question.answer.includes(letter)) button.classList.add("correct");
    else if (state.selected.has(letter)) button.classList.add("wrong");
  });
  const panel = $("#result-panel");
  panel.className = `result-panel${correct ? "" : " wrong"}`;
  panel.innerHTML = `<strong>${correct ? "回答正确" : `回答错误 · 正确答案 ${question.answer}`}</strong><p>${escapeHtml(question.explanation)}</p>`;
  $("#submit-button").textContent = state.sessionIndex < state.session.length - 1 ? "已提交" : "已完成";
  $("#submit-button").disabled = true;
  updateHistoryStatus(state.records[question.id]);
  renderNavigator();
  updateDashboard();
}

function submitExamAnswer() {
  const question = currentQuestion();
  if (!question) return;
  if (!state.selected.size) {
    showToast("请先选择答案；也可以用题号卡跳到其他题");
    return;
  }
  state.examAnswers[question.id] = [...state.selected].sort();
  if (state.sessionIndex < state.session.length - 1) {
    goToQuestion(state.sessionIndex + 1);
  } else {
    finishExam();
  }
}

function finishExam() {
  const unanswered = state.session.filter((question) => !(state.examAnswers[question.id] || []).length).length;
  if (unanswered && !confirm(`还有 ${unanswered} 道题未作答，确定现在交卷吗？`)) return;
  let correct = 0;
  state.session.forEach((question) => {
    const answer = (state.examAnswers[question.id] || []).sort();
    if (!answer.length) return;
    const isCorrect = answer.join("") === question.answer;
    if (isCorrect) correct += 1;
    const previous = questionRecord(question.id);
    state.records[question.id] = {
      attempts: previous.attempts + 1,
      correctCount: previous.correctCount + (isCorrect ? 1 : 0),
      lastCorrect: isCorrect,
      lastAnswer: answer,
      lastAt: new Date().toISOString(),
    };
  });
  state.examScore = { correct, total: state.session.length, unanswered };
  state.examSubmitted = true;
  state.sessionIndex = 0;
  saveLocalState();
  updateDashboard();
  renderQuestion();
  showToast(`已交卷：答对 ${correct} / ${state.session.length} 题`);
}

function goToQuestion(index) {
  if (index < 0 || index >= state.session.length) return;
  state.sessionIndex = index;
  renderQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
  closeNavigator();
}

function toggleFavorite() {
  const question = currentQuestion();
  if (!question) return;
  if (isFavorite(question.id)) state.favorites = state.favorites.filter((id) => id !== question.id);
  else state.favorites.push(question.id);
  saveLocalState();
  renderQuestion();
  updateDashboard();
}

function renderNavigatorGrid(target) {
  target.innerHTML = state.session.map((question, index) => {
    const record = questionRecord(question.id);
    let status = record.attempts ? (record.lastCorrect ? "correct" : "wrong") : "";
    if (state.examMode && !state.examSubmitted) status = (state.examAnswers[question.id] || []).length ? "answered" : "";
    if (state.examMode && state.examSubmitted) {
      const selected = (state.examAnswers[question.id] || []).sort().join("");
      status = selected ? (selected === question.answer ? "correct" : "wrong") : "";
    }
    const current = index === state.sessionIndex ? "current" : "";
    const favorite = isFavorite(question.id) ? "favorite" : "";
    return `<button class="question-number ${status} ${current} ${favorite}" data-jump="${index}" aria-label="第 ${index + 1} 题">${index + 1}</button>`;
  }).join("");
}

function renderNavigator() {
  renderNavigatorGrid($("#desktop-question-grid"));
  renderNavigatorGrid($("#mobile-question-grid"));
  const answered = state.examMode && !state.examSubmitted
    ? state.session.filter((question) => (state.examAnswers[question.id] || []).length).length
    : state.session.filter((question) => questionRecord(question.id).attempts).length;
  $("#desktop-nav-summary").textContent = `已做 ${answered}/${state.session.length}`;
}

function openNavigator() {
  $("#navigator-overlay").classList.remove("hidden");
  $("#navigator-overlay").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeNavigator() {
  $("#navigator-overlay").classList.add("hidden");
  $("#navigator-overlay").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function renderList(kind) {
  const favorites = kind === "favorites";
  const questions = state.usableQuestions.filter((question) => favorites ? isFavorite(question.id) : questionRecord(question.id).lastCorrect === false);
  $("#list-eyebrow").textContent = favorites ? "重点回看" : "薄弱环节";
  $("#list-title").textContent = favorites ? "收藏题目" : "错题本";
  $("#list-count").textContent = `${questions.length} 题`;
  $("#question-list").innerHTML = questions.length ? questions.map((question, index) => {
    const record = questionRecord(question.id);
    return `<button class="list-item ${favorites ? "favorite" : ""}" data-list-kind="${kind}" data-question-id="${question.id}">
      <span class="list-index">${favorites ? "★" : index + 1}</span>
      <span><strong>${escapeHtml(question.stem)}</strong><small>${escapeHtml(formatChapter(question.chapter))}${record.attempts ? ` · 已做 ${record.attempts} 次` : ""}</small></span>
      <span class="list-arrow">→</span>
    </button>`;
  }).join("") : `<div class="empty-state"><strong>${favorites ? "还没有收藏题目" : "目前没有错题"}</strong><p>${favorites ? "刷题时点击收藏，即可在这里集中复习。" : "继续保持，新的错题会自动归入这里。"}</p><button class="primary-button" data-mode="sequential">开始刷题</button></div>`;
  showView("list");
}

function renderStats() {
  const answered = answeredQuestions();
  const attempts = Object.values(state.records).reduce((sum, record) => sum + record.attempts, 0);
  const correct = Object.values(state.records).reduce((sum, record) => sum + record.correctCount, 0);
  const chapterGroups = new Map();
  state.reliableQuestions.forEach((question) => {
    if (!chapterGroups.has(question.chapter)) chapterGroups.set(question.chapter, []);
    chapterGroups.get(question.chapter).push(question);
  });
  $("#stats-content").innerHTML = `<div class="stats-grid">
    <article class="stat-card"><span>完成题目</span><strong>${answered.length}</strong><span>覆盖 ${state.reliableQuestions.length ? Math.round(answered.length / state.reliableQuestions.length * 100) : 0}%</span></article>
    <article class="stat-card"><span>累计作答</span><strong>${attempts}</strong><span>包含重复练习</span></article>
    <article class="stat-card"><span>累计正确率</span><strong>${attempts ? Math.round(correct / attempts * 100) : 0}%</strong><span>答对 ${correct} 次</span></article>
  </div><div class="stat-list">${[...chapterGroups.entries()].map(([chapter, questions]) => {
    const done = questions.filter((question) => questionRecord(question.id).attempts).length;
    const percent = Math.round(done / questions.length * 100);
    return `<div class="stat-row"><span><strong>${escapeHtml(formatChapter(chapter))}</strong><br><small>${done} / ${questions.length} 题</small></span><span class="mini-progress"><span style="width:${percent}%"></span></span><strong>${percent}%</strong></div>`;
  }).join("")}</div>`;
  showView("stats");
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  saveLocalState();
}

function resetProgress() {
  if (!confirm("确定清空所有答题记录吗？收藏内容会保留。")) return;
  state.records = {};
  state.lastQuestionId = null;
  saveLocalState();
  updateDashboard();
  showToast("答题记录已清空");
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const safeRegister = (tool) => Promise.resolve(context.registerTool(tool)).catch(() => {});
  const mockPaperNames = [...new Set(state.usableQuestions.flatMap((question) => question.mockPapers || []))]
    .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
  safeRegister({
    name: "start_practice",
    title: "开始刷题",
    description: "开始顺序、随机、错题、收藏或机考重点练习，并在页面中打开第一题。",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["sequential", "random", "wrong", "favorites", "machine"] } }, required: ["mode"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute({ mode }) { startSession(mode); return { mode, questionCount: state.session.length }; },
  });
  safeRegister({
    name: "start_mock_test",
    title: "开始模拟测试",
    description: "开始一套覆盖导论至第七章的模拟测试，作答期间不显示答案，交卷后统一评分。",
    inputSchema: { type: "object", properties: { paper: { type: "string", enum: mockPaperNames } }, required: ["paper"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute({ paper }) { startMockPaper(paper); return { paper, questionCount: state.session.length }; },
  });
  safeRegister({
    name: "get_study_progress",
    title: "读取学习进度",
    description: "读取题库完成量、错题数和收藏数，不改变学习记录。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() { return { total: state.reliableQuestions.length, completed: answeredQuestions().length, wrong: state.reliableQuestions.filter((question) => questionRecord(question.id).lastCorrect === false).length, favorites: state.favorites.length }; },
  });
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const option = event.target.closest("[data-option]");
    if (option) return chooseOption(option.dataset.option);
    const jump = event.target.closest("[data-jump]");
    if (jump) return goToQuestion(Number(jump.dataset.jump));
    const chapter = event.target.closest("[data-chapter]");
    if (chapter) return startSession("chapter", chapter.dataset.chapter);
    const paper = event.target.closest("[data-paper]");
    if (paper) return startMockPaper(paper.dataset.paper);
    const mode = event.target.closest("[data-mode]");
    if (mode) return startSession(mode.dataset.mode);
    const listItem = event.target.closest("[data-question-id]");
    if (listItem) return startSession(listItem.dataset.listKind === "favorites" ? "favorites" : "wrong", null, listItem.dataset.questionId);
    const home = event.target.closest("[data-action='home']");
    if (home) { updateDashboard(); return showView("home"); }
    const mockLink = event.target.closest("[data-action='show-mocks']");
    if (mockLink) return $("#mock-section").scrollIntoView({ behavior: "smooth", block: "start" });
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      if (tab.dataset.tab === "home") { updateDashboard(); showView("home"); }
      else if (tab.dataset.tab === "practice") startSession("continue");
      else if (tab.dataset.tab === "wrong") renderList("wrong");
      else if (tab.dataset.tab === "favorites") renderList("favorites");
      else if (tab.dataset.tab === "stats") renderStats();
    }
  });
  $("#submit-button").addEventListener("click", submitAnswer);
  $("#previous-button").addEventListener("click", () => goToQuestion(state.sessionIndex - 1));
  $("#next-button").addEventListener("click", () => goToQuestion(state.sessionIndex + 1));
  $("#favorite-button").addEventListener("click", toggleFavorite);
  $("#navigator-button").addEventListener("click", openNavigator);
  $("#close-navigator").addEventListener("click", closeNavigator);
  $(".overlay-backdrop").addEventListener("click", closeNavigator);
  $("#theme-button").addEventListener("click", toggleTheme);
  $("#reset-progress").addEventListener("click", resetProgress);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    $("#install-button").classList.remove("hidden");
  });
  $("#install-button").addEventListener("click", async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $("#install-button").classList.add("hidden");
  });
}

async function init() {
  loadLocalState();
  bindEvents();
  try {
    const response = await fetch("./data/questions.json?v=10");
    if (!response.ok) throw new Error("题库载入失败");
    state.questions = await response.json();
    state.usableQuestions = state.questions.filter((question) => question.answer && !question.needsReview && Object.keys(question.options || {}).includes(question.answer[0]));
    state.reliableQuestions = state.usableQuestions.filter((question) => question.chapter !== "未分类");
    updateDashboard();
    registerWebMcpTools();
    $("#loading").classList.add("hidden");
  } catch (error) {
    $("#loading").innerHTML = `<p>${escapeHtml(error.message)}，请刷新后重试。</p>`;
  }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init();
