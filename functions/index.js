const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const CATEGORIES = ["餐飲", "交通", "生活用品", "醫療", "娛樂", "其他"];

function formatDate(date) {
  const taipei = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const m = taipei.getMonth() + 1;
  const d = taipei.getDate();
  const wd = ["日", "一", "二", "三", "四", "五", "六"][taipei.getDay()];
  return `${m}/${d}(${wd})`;
}

function taipeiNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
}

function yearMonthOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// ---------- LINE API helpers ----------

async function replyMessage(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
}

async function pushMessage(to, text) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
}

async function getDisplayName(source) {
  try {
    if (source.type === "group") {
      const res = await fetch(
        `https://api.line.me/v2/bot/group/${source.groupId}/member/${source.userId}`,
        { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
      );
      const data = await res.json();
      return data.displayName || "家人";
    } else {
      const res = await fetch(`https://api.line.me/v2/bot/profile/${source.userId}`, {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      });
      const data = await res.json();
      return data.displayName || "家人";
    }
  } catch (e) {
    return "家人";
  }
}

function getGroupId(source) {
  return source.groupId || source.roomId || source.userId;
}

// ---------- 記帳（支出） ----------

function parseExpense(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const amountStr = tokens[tokens.length - 1];
  const amount = parseFloat(amountStr.replace(/[,元]/g, ""));
  if (isNaN(amount)) return null;

  let category = "其他";
  let itemTokens;
  if (CATEGORIES.includes(tokens[0])) {
    category = tokens[0];
    itemTokens = tokens.slice(1, -1);
  } else {
    itemTokens = tokens.slice(0, -1);
  }
  const item = itemTokens.join(" ").trim();
  if (!item) return null;

  return { category, item, amount };
}

async function checkBudgetWarning(groupId, category) {
  const settingsDoc = await db.collection("settings").doc(groupId).get();
  const budgets = settingsDoc.exists ? settingsDoc.data().budgets || {} : {};
  const budget = budgets[category];
  if (!budget) return "";

  const yearMonth = yearMonthOf(taipeiNow());
  const snap = await db.collection("expenses").where("groupId", "==", groupId).get();
  const spent = snap.docs
    .map((d) => d.data())
    .filter((d) => d.yearMonth === yearMonth && d.category === category)
    .reduce((s, d) => s + d.amount, 0);

  if (spent >= budget) {
    return `\n\n⚠️ 本月「${category}」已超支！$${spent}／預算 $${budget}`;
  } else if (spent >= budget * 0.8) {
    return `\n\n🔔 本月「${category}」已花 $${spent}，接近預算 $${budget}`;
  }
  return "";
}

async function handleDeleteExpense(keyword, groupId, replyToken) {
  if (!keyword) {
    await replyMessage(replyToken, "格式: 刪除記帳 關鍵字\n例如: 刪除記帳 午餐");
    return;
  }
  const snap = await db.collection("expenses").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .filter((d) => d.data().item.includes(keyword))
    .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, `找不到符合「${keyword}」的記帳紀錄`);
    return;
  }
  const target = docs[0];
  const data = target.data();
  await target.ref.delete();
  await replyMessage(replyToken, `已刪除 🗑️\n${data.category} - ${data.item} $${data.amount}`);
}

async function handleEditExpense(text, groupId, senderName, replyToken) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    await replyMessage(
      replyToken,
      "格式: 改記帳 舊關鍵字 類別 項目 金額\n例如: 改記帳 午餐 餐飲 排骨飯 120\n(類別可省略)"
    );
    return;
  }
  const keyword = tokens[0];
  const parsed = parseExpense(tokens.slice(1).join(" "));
  if (!parsed) {
    await replyMessage(replyToken, "新內容格式不對喔～請用: 改記帳 舊關鍵字 類別 項目 金額");
    return;
  }

  const snap = await db.collection("expenses").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .filter((d) => d.data().item.includes(keyword))
    .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, `找不到符合「${keyword}」的記帳紀錄`);
    return;
  }
  const target = docs[0];
  const old = target.data();
  await target.ref.update({
    category: parsed.category,
    item: parsed.item,
    amount: parsed.amount,
    editedBy: senderName,
    editedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await replyMessage(
    replyToken,
    `已修改 ✏️\n${old.category} - ${old.item} $${old.amount}\n→ ${parsed.category} - ${parsed.item} $${parsed.amount}\n修改人: ${senderName}`
  );
}

async function handleAddExpense(text, groupId, senderName, replyToken) {
  const parsed = parseExpense(text);
  if (!parsed) {
    await replyMessage(
      replyToken,
      "格式不對喔～請用:\n記帳 類別 項目 金額\n例如: 記帳 餐飲 午餐 150\n(類別可省略，會自動歸類「其他」)\n\n可用類別: " +
        CATEGORIES.join("/")
    );
    return;
  }
  const now = taipeiNow();
  const yearMonth = yearMonthOf(now);

  await db.collection("expenses").add({
    groupId,
    category: parsed.category,
    item: parsed.item,
    amount: parsed.amount,
    sender: senderName,
    yearMonth,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  const warning = await checkBudgetWarning(groupId, parsed.category);

  await replyMessage(
    replyToken,
    `已記帳 ✅\n${parsed.category} - ${parsed.item}\n金額: $${parsed.amount}\n日期: ${formatDate(now)}\n記錄人: ${senderName}${warning}`
  );
}

async function handleQueryExpense(text, groupId, replyToken) {
  const arg = text.trim();
  const yearMonth = yearMonthOf(taipeiNow());

  const snap = await db.collection("expenses").where("groupId", "==", groupId).get();
  let docs = snap.docs.map((d) => d.data()).filter((d) => d.yearMonth === yearMonth);

  let title = `📊 本月(${yearMonth})記帳統計`;
  if (arg && CATEGORIES.includes(arg)) {
    docs = docs.filter((d) => d.category === arg);
    title = `📊 本月「${arg}」明細`;
  }

  if (docs.length === 0) {
    await replyMessage(replyToken, "本月還沒有任何記帳紀錄喔");
    return;
  }

  docs.sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));

  if (arg && CATEGORIES.includes(arg)) {
    const lines = docs
      .slice(0, 15)
      .map((d) => `・${formatDate(d.timestamp?.toDate?.() || new Date())} ${d.item} $${d.amount} (${d.sender})`);
    const total = docs.reduce((s, d) => s + d.amount, 0);
    await replyMessage(replyToken, `${title}\n${lines.join("\n")}\n\n小計: $${total}`);
  } else {
    const byCategory = {};
    let total = 0;
    for (const d of docs) {
      byCategory[d.category] = (byCategory[d.category] || 0) + d.amount;
      total += d.amount;
    }
    const lines = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `・${cat}: $${amt}`);

    const incomeSnap = await db.collection("incomes").where("groupId", "==", groupId).get();
    const incomeTotal = incomeSnap.docs
      .map((d) => d.data())
      .filter((d) => d.yearMonth === yearMonth)
      .reduce((s, d) => s + d.amount, 0);
    const balance = incomeTotal - total;

    await replyMessage(
      replyToken,
      `${title}\n${lines.join("\n")}\n\n支出總計: $${total}\n收入總計: $${incomeTotal}\n結餘: $${balance}\n\n輸入「查帳 類別」可看明細`
    );
  }
}

// ---------- 收入 ----------

function parseIncome(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const amountStr = tokens[tokens.length - 1];
  const amount = parseFloat(amountStr.replace(/[,元]/g, ""));
  if (isNaN(amount)) return null;
  const item = tokens.slice(0, -1).join(" ").trim();
  if (!item) return null;
  return { item, amount };
}

async function handleAddIncome(text, groupId, senderName, replyToken) {
  const parsed = parseIncome(text);
  if (!parsed) {
    await replyMessage(replyToken, "格式: 收入 項目 金額\n例如: 收入 薪水 45000");
    return;
  }
  const now = taipeiNow();
  const yearMonth = yearMonthOf(now);

  await db.collection("incomes").add({
    groupId,
    item: parsed.item,
    amount: parsed.amount,
    sender: senderName,
    yearMonth,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await replyMessage(
    replyToken,
    `已記錄收入 ✅\n${parsed.item}\n金額: $${parsed.amount}\n日期: ${formatDate(now)}\n記錄人: ${senderName}`
  );
}

async function handleQueryIncome(groupId, replyToken) {
  const yearMonth = yearMonthOf(taipeiNow());
  const snap = await db.collection("incomes").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .map((d) => d.data())
    .filter((d) => d.yearMonth === yearMonth)
    .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, "本月還沒有任何收入紀錄喔");
    return;
  }
  const lines = docs.map((d) => `・${formatDate(d.timestamp?.toDate?.() || new Date())} ${d.item} $${d.amount} (${d.sender})`);
  const total = docs.reduce((s, d) => s + d.amount, 0);
  await replyMessage(replyToken, `💰 本月(${yearMonth})收入\n${lines.join("\n")}\n\n總計: $${total}`);
}

// ---------- 預算 ----------

async function handleSetBudget(text, groupId, replyToken) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 2 || !CATEGORIES.includes(tokens[0])) {
    await replyMessage(
      replyToken,
      "格式: 設定預算 類別 金額\n例如: 設定預算 餐飲 3000\n可用類別: " + CATEGORIES.join("/")
    );
    return;
  }
  const category = tokens[0];
  const amount = parseFloat(tokens[1]);
  if (isNaN(amount)) {
    await replyMessage(replyToken, "金額格式不對喔～請用: 設定預算 類別 金額");
    return;
  }

  await db.collection("settings").doc(groupId).set(
    { budgets: { [category]: amount } },
    { merge: true }
  );
  await replyMessage(replyToken, `已設定預算 ✅\n${category}: $${amount} / 月`);
}

async function handleQueryBudget(groupId, replyToken) {
  const settingsDoc = await db.collection("settings").doc(groupId).get();
  const budgets = settingsDoc.exists ? settingsDoc.data().budgets || {} : {};
  const categories = Object.keys(budgets);

  if (categories.length === 0) {
    await replyMessage(replyToken, "目前還沒有設定任何預算\n格式: 設定預算 類別 金額");
    return;
  }

  const yearMonth = yearMonthOf(taipeiNow());
  const snap = await db.collection("expenses").where("groupId", "==", groupId).get();
  const docs = snap.docs.map((d) => d.data()).filter((d) => d.yearMonth === yearMonth);

  const lines = categories.map((cat) => {
    const spent = docs.filter((d) => d.category === cat).reduce((s, d) => s + d.amount, 0);
    const budget = budgets[cat];
    const pct = Math.round((spent / budget) * 100);
    const flag = spent >= budget ? "⚠️" : spent >= budget * 0.8 ? "🔔" : "✅";
    return `${flag} ${cat}: $${spent} / $${budget} (${pct}%)`;
  });

  await replyMessage(replyToken, `💳 本月(${yearMonth})預算狀況\n${lines.join("\n")}`);
}

// ---------- 待辦 ----------

function parseDueDate(content) {
  const tokens = content.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { content: content.trim(), dueMonth: null, dueDay: null };
  const last = tokens[tokens.length - 1];
  const m = last.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return {
      content: tokens.slice(0, -1).join(" "),
      dueMonth: parseInt(m[1], 10),
      dueDay: parseInt(m[2], 10),
    };
  }
  return { content: content.trim(), dueMonth: null, dueDay: null };
}

async function handleDeleteTodo(keyword, groupId, replyToken) {
  if (!keyword) {
    await replyMessage(replyToken, "格式: 刪除待辦 關鍵字\n例如: 刪除待辦 買尿布");
    return;
  }
  const snap = await db.collection("todos").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .filter((d) => d.data().content.includes(keyword))
    .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, `找不到符合「${keyword}」的待辦事項`);
    return;
  }
  const target = docs[0];
  const content = target.data().content;
  await target.ref.delete();
  await replyMessage(replyToken, `已刪除待辦 🗑️\n「${content}」`);
}

async function handleEditTodo(text, groupId, senderName, replyToken) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    await replyMessage(replyToken, "格式: 改待辦 舊關鍵字 新內容\n例如: 改待辦 尿布 買濕紙布");
    return;
  }
  const keyword = tokens[0];
  const newContentRaw = tokens.slice(1).join(" ");
  const { content: newContent, dueMonth, dueDay } = parseDueDate(newContentRaw);

  const snap = await db.collection("todos").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .filter((d) => d.data().content.includes(keyword))
    .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, `找不到符合「${keyword}」的待辦事項`);
    return;
  }
  const target = docs[0];
  const old = target.data().content;
  await target.ref.update({
    content: newContent,
    dueMonth: dueMonth || null,
    dueDay: dueDay || null,
    remindedDate: null,
    editedBy: senderName,
    editedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await replyMessage(replyToken, `已修改待辦 ✏️\n「${old}」→「${newContent}」\n修改人: ${senderName}`);
}

async function handleAddTodo(text, groupId, senderName, replyToken) {
  if (!text) {
    await replyMessage(replyToken, "格式: 待辦 內容 (日期可省略)\n例如: 待辦 買尿布\n待辦 倒垃圾 7/20");
    return;
  }
  const { content, dueMonth, dueDay } = parseDueDate(text);
  if (!content) {
    await replyMessage(replyToken, "格式: 待辦 內容 (日期可省略)\n例如: 待辦 買尿布\n待辦 倒垃圾 7/20");
    return;
  }

  await db.collection("todos").add({
    groupId,
    content,
    done: false,
    dueMonth: dueMonth || null,
    dueDay: dueDay || null,
    remindedDate: null,
    sender: senderName,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  const dueText = dueMonth ? `\n提醒日期: ${dueMonth}/${dueDay}` : "";
  await replyMessage(replyToken, `已加入待辦 ✅\n「${content}」${dueText}\n新增人: ${senderName}`);
}

async function handleQueryTodo(groupId, replyToken) {
  const snap = await db.collection("todos").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .map((d) => d.data())
    .filter((d) => !d.done)
    .sort((a, b) => (a.timestamp?.toMillis?.() || 0) - (b.timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, "目前沒有待辦事項 🎉");
    return;
  }
  const lines = docs.map((d, i) => {
    const due = d.dueMonth ? ` (${d.dueMonth}/${d.dueDay})` : "";
    return `${i + 1}. ${d.content}${due} (${d.sender})`;
  });
  await replyMessage(replyToken, `📝 待辦事項\n${lines.join("\n")}\n\n完成後輸入「完成 關鍵字」`);
}

async function handleCompleteTodo(keyword, groupId, senderName, replyToken) {
  if (!keyword) {
    await replyMessage(replyToken, "格式: 完成 關鍵字\n例如: 完成 買尿布");
    return;
  }
  const snap = await db.collection("todos").where("groupId", "==", groupId).get();
  const target = snap.docs.find((d) => !d.data().done && d.data().content.includes(keyword));

  if (!target) {
    await replyMessage(replyToken, `找不到符合「${keyword}」的待辦事項`);
    return;
  }
  await target.ref.update({
    done: true,
    doneBy: senderName,
    doneAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await replyMessage(replyToken, `已完成 ✅\n「${target.data().content}」\n完成人: ${senderName}`);
}

// ---------- 備忘 ----------

async function handleDeleteNote(keyword, groupId, replyToken) {
  if (!keyword) {
    await replyMessage(replyToken, "格式: 刪除備忘 關鍵字\n例如: 刪除備忘 聚餐");
    return;
  }
  const snap = await db.collection("notes").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .filter((d) => d.data().content.includes(keyword))
    .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, `找不到符合「${keyword}」的備忘紀錄`);
    return;
  }
  const target = docs[0];
  const content = target.data().content;
  await target.ref.delete();
  await replyMessage(replyToken, `已刪除備忘 🗑️\n「${content}」`);
}

async function handleEditNote(text, groupId, senderName, replyToken) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    await replyMessage(replyToken, "格式: 改備忘 舊關鍵字 新內容\n例如: 改備忘 聚餐 改成週六聚餐");
    return;
  }
  const keyword = tokens[0];
  const newContent = tokens.slice(1).join(" ");

  const snap = await db.collection("notes").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .filter((d) => d.data().content.includes(keyword))
    .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));

  if (docs.length === 0) {
    await replyMessage(replyToken, `找不到符合「${keyword}」的備忘紀錄`);
    return;
  }
  const target = docs[0];
  const old = target.data().content;
  await target.ref.update({
    content: newContent,
    editedBy: senderName,
    editedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await replyMessage(replyToken, `已修改備忘 ✏️\n「${old}」→「${newContent}」\n修改人: ${senderName}`);
}

async function handleAddNote(content, groupId, senderName, replyToken) {
  if (!content) {
    await replyMessage(replyToken, "格式: 備忘 內容\n例如: 備忘 週日阿嬤生日");
    return;
  }
  await db.collection("notes").add({
    groupId,
    content,
    sender: senderName,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  await replyMessage(replyToken, `已記錄備忘 ✅\n「${content}」\n日期: ${formatDate(taipeiNow())}\n記錄人: ${senderName}`);
}

async function handleQueryNote(groupId, replyToken) {
  const snap = await db.collection("notes").where("groupId", "==", groupId).get();
  const docs = snap.docs
    .map((d) => d.data())
    .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0))
    .slice(0, 10);

  if (docs.length === 0) {
    await replyMessage(replyToken, "目前沒有備忘紀錄");
    return;
  }

  const groups = [];
  for (const d of docs) {
    const dateLabel = formatDate(d.timestamp?.toDate?.() || new Date());
    let group = groups.find((g) => g.dateLabel === dateLabel);
    if (!group) {
      group = { dateLabel, items: [] };
      groups.push(group);
    }
    group.items.push(d);
  }

  let text = "📌 最近備忘\n";
  for (const g of groups) {
    text += `\n${g.dateLabel}\n`;
    text += g.items.map((d, i) => `${i + 1}. ${d.content} (${d.sender})`).join("\n");
  }

  await replyMessage(replyToken, text);
}

// ---------- 依日期查詢 ----------

async function handleQueryByDate(year, month, day, groupId, replyToken) {
  const expSnap = await db.collection("expenses").where("groupId", "==", groupId).get();
  const noteSnap = await db.collection("notes").where("groupId", "==", groupId).get();

  const matchDate = (timestamp) => {
    if (!timestamp?.toDate) return false;
    const d = new Date(timestamp.toDate().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    const monthDayMatch = d.getMonth() + 1 === month && d.getDate() === day;
    if (!monthDayMatch) return false;
    return year ? d.getFullYear() === year : true;
  };

  const expenses = expSnap.docs
    .map((d) => d.data())
    .filter((d) => matchDate(d.timestamp))
    .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));

  const notes = noteSnap.docs
    .map((d) => d.data())
    .filter((d) => matchDate(d.timestamp))
    .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));

  const label = year ? `${year}/${month}/${day}` : `${month}/${day}`;

  if (expenses.length === 0 && notes.length === 0) {
    await replyMessage(replyToken, `找不到 ${label} 的任何記帳或備忘紀錄`);
    return;
  }

  let text = `📅 ${label} 紀錄\n`;

  if (expenses.length > 0) {
    const total = expenses.reduce((s, d) => s + d.amount, 0);
    text += `\n【記帳】\n`;
    text += expenses.map((d) => `・${d.category} ${d.item} $${d.amount} (${d.sender})`).join("\n");
    text += `\n小計: $${total}`;
  }

  if (notes.length > 0) {
    text += `\n\n【備忘】\n`;
    text += notes.map((d) => `・${d.content} (${d.sender})`).join("\n");
  }

  await replyMessage(replyToken, text);
}

// ---------- 每日提醒（兩種：每日摘要 + 待辦到期提醒） ----------

async function handleSetReminder(text, groupId, replyToken) {
  const arg = text.trim();

  if (arg === "關閉") {
    await db.collection("settings").doc(groupId).set({ reminderEnabled: false }, { merge: true });
    await replyMessage(replyToken, "已關閉每日待辦提醒 🔕");
    return;
  }

  if (!arg) {
    const doc = await db.collection("settings").doc(groupId).get();
    const data = doc.exists ? doc.data() : {};
    if (data.reminderEnabled) {
      await replyMessage(replyToken, `目前每日提醒：開啟 ⏰ ${data.reminderTime}\n關閉請輸入「提醒 關閉」`);
    } else {
      await replyMessage(replyToken, `目前每日提醒：關閉\n開啟請輸入「提醒 時間」，例如: 提醒 20:00`);
    }
    return;
  }

  const match = arg.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    await replyMessage(replyToken, "格式: 提醒 時間\n例如: 提醒 20:00\n關閉請輸入: 提醒 關閉");
    return;
  }
  const hh = String(parseInt(match[1], 10)).padStart(2, "0");
  const mm = match[2];
  const time = `${hh}:${mm}`;

  await db.collection("settings").doc(groupId).set(
    { reminderEnabled: true, reminderTime: time },
    { merge: true }
  );
  await replyMessage(replyToken, `已開啟每日待辦提醒 ⏰\n時間: ${time}\n（每天這個時間會自動傳目前所有未完成待辦）`);
}

const DUE_DATE_CHECK_TIME = "08:00"; // 每天固定檢查一次「今天到期」的待辦

exports.dailyReminderCheck = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Asia/Taipei" },
  async () => {
    const taipei = taipeiNow();
    const hh = String(taipei.getHours()).padStart(2, "0");
    const mm = String(taipei.getMinutes()).padStart(2, "0");
    const currentTime = `${hh}:${mm}`;

    // 1. 各群組自訂的每日待辦摘要時間
    const settingsSnap = await db
      .collection("settings")
      .where("reminderEnabled", "==", true)
      .where("reminderTime", "==", currentTime)
      .get();

    for (const doc of settingsSnap.docs) {
      const groupId = doc.id;
      const todoSnap = await db.collection("todos").where("groupId", "==", groupId).get();
      const undone = todoSnap.docs
        .map((d) => d.data())
        .filter((d) => !d.done)
        .sort((a, b) => (a.timestamp?.toMillis?.() || 0) - (b.timestamp?.toMillis?.() || 0));

      let text;
      if (undone.length === 0) {
        text = "⏰ 每日待辦提醒\n目前沒有待辦事項 🎉";
      } else {
        const lines = undone.map((d, i) => {
          const due = d.dueMonth ? ` (${d.dueMonth}/${d.dueDay})` : "";
          return `${i + 1}. ${d.content}${due} (${d.sender})`;
        });
        text = `⏰ 每日待辦提醒\n${lines.join("\n")}`;
      }
      await pushMessage(groupId, text);
    }

    // 2. 固定時間檢查「今天到期」的待辦事項（不論有沒有開啟每日摘要）
    if (currentTime === DUE_DATE_CHECK_TIME) {
      const todayMonth = taipei.getMonth() + 1;
      const todayDay = taipei.getDate();
      const todayStr = `${taipei.getFullYear()}-${todayMonth}-${todayDay}`;

      const dueSnap = await db
        .collection("todos")
        .where("done", "==", false)
        .where("dueMonth", "==", todayMonth)
        .where("dueDay", "==", todayDay)
        .get();

      const byGroup = {};
      for (const doc of dueSnap.docs) {
        const data = doc.data();
        if (data.remindedDate === todayStr) continue; // 今天已提醒過，避免重複
        if (!byGroup[data.groupId]) byGroup[data.groupId] = [];
        byGroup[data.groupId].push({ ref: doc.ref, data });
      }

      for (const groupId of Object.keys(byGroup)) {
        const items = byGroup[groupId];
        const lines = items.map((it, i) => `${i + 1}. ${it.data.content} (${it.data.sender})`);
        const text = `📅 今天到期的待辦\n${lines.join("\n")}`;
        await pushMessage(groupId, text);
        await Promise.all(items.map((it) => it.ref.update({ remindedDate: todayStr })));
      }
    }
  }
);

// ---------- 說明 ----------

const HELP_TEXT = `🏠 家庭小管家 使用說明

【記帳（支出）】
記帳 類別 項目 金額 (類別可省略)
查帳 / 查帳 類別
改記帳 舊關鍵字 類別 項目 金額
刪除記帳 關鍵字

【收入】
收入 項目 金額
查收入

【預算】
設定預算 類別 金額
查預算

【待辦】
待辦 內容 (日期可省略，如: 待辦 倒垃圾 7/20)
查待辦
完成 關鍵字
改待辦 舊關鍵字 新內容
刪除待辦 關鍵字

【備忘】
備忘 內容
查備忘
改備忘 舊關鍵字 新內容
刪除備忘 關鍵字

【依日期查詢】
查7/12 → 叫出每年7/12的記帳+備忘
查2026/7/12 → 只查該年當天

【每日提醒】
提醒 20:00 → 每天這個時間自動傳待辦清單
提醒 關閉 → 關閉提醒
提醒 → 查看目前設定
（有設日期的待辦，當天早上8點會自動提醒一次）

可用類別: ${CATEGORIES.join("/")}`;

// ---------- 一次性設定：建立底部固定選單 ----------
exports.setupRichMenu = onRequest(async (req, res) => {
  if (req.query.secret !== LINE_CHANNEL_SECRET) {
    res.status(403).send("Forbidden");
    return;
  }

  try {
    const imgRes = await fetch("https://dukelin047.github.io/Jarvis/richmenu.png");
    if (!imgRes.ok) throw new Error("找不到 richmenu.png，請先上傳到 repo 根目錄");
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const labels = ["記帳", "查帳", "待辦", "查待辦", "完成", "備忘", "查備忘", "說明"];
    const CW = 2500 / 4;
    const CH = 1686 / 2;
    const areas = labels.map((text, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      return {
        bounds: { x: Math.round(col * CW), y: Math.round(row * CH), width: Math.round(CW), height: Math.round(CH) },
        action: { type: "message", text },
      };
    });

    const createRes = await fetch("https://api.line.me/v2/bot/richmenu", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        size: { width: 2500, height: 1686 },
        selected: true,
        name: "家庭小管家選單",
        chatBarText: "選單",
        areas,
      }),
    });
    const createData = await createRes.json();
    if (!createData.richMenuId) throw new Error("建立選單失敗: " + JSON.stringify(createData));
    const richMenuId = createData.richMenuId;

    const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: imgBuffer,
    });
    if (!uploadRes.ok) throw new Error("上傳圖片失敗: " + (await uploadRes.text()));

    const defaultRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!defaultRes.ok) throw new Error("設定預設選單失敗: " + (await defaultRes.text()));

    res.status(200).send(`選單設定成功！richMenuId: ${richMenuId}\n請重新打開 LINE 聊天室查看效果（可能需要切換分頁或重進聊天室）。`);
  } catch (err) {
    console.error(err);
    res.status(500).send("設定失敗: " + err.message);
  }
});

// ---------- 主 webhook ----------

exports.lineWebhook = onRequest(async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  if (signature !== hash) {
    res.status(401).send("Invalid signature");
    return;
  }

  const events = req.body.events || [];

  await Promise.all(
    events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") return;

      const text = event.message.text.trim();
      const groupId = getGroupId(event.source);
      const replyToken = event.replyToken;

      try {
        const dateMatch = text.match(/^查\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})$/);
        if (dateMatch) {
          const year = dateMatch[1] ? parseInt(dateMatch[1], 10) : null;
          const month = parseInt(dateMatch[2], 10);
          const day = parseInt(dateMatch[3], 10);
          await handleQueryByDate(year, month, day, groupId, replyToken);
        } else if (text.startsWith("刪除記帳")) {
          await handleDeleteExpense(text.slice(4).trim(), groupId, replyToken);
        } else if (text.startsWith("改記帳")) {
          const senderName = await getDisplayName(event.source);
          await handleEditExpense(text.slice(3).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("記帳")) {
          const senderName = await getDisplayName(event.source);
          await handleAddExpense(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("查帳")) {
          await handleQueryExpense(text.slice(2).trim(), groupId, replyToken);
        } else if (text.startsWith("設定預算")) {
          await handleSetBudget(text.slice(4).trim(), groupId, replyToken);
        } else if (text.startsWith("查預算")) {
          await handleQueryBudget(groupId, replyToken);
        } else if (text.startsWith("查收入")) {
          await handleQueryIncome(groupId, replyToken);
        } else if (text.startsWith("收入")) {
          const senderName = await getDisplayName(event.source);
          await handleAddIncome(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("刪除待辦")) {
          await handleDeleteTodo(text.slice(4).trim(), groupId, replyToken);
        } else if (text.startsWith("改待辦")) {
          const senderName = await getDisplayName(event.source);
          await handleEditTodo(text.slice(3).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("查待辦")) {
          await handleQueryTodo(groupId, replyToken);
        } else if (text.startsWith("待辦")) {
          const senderName = await getDisplayName(event.source);
          await handleAddTodo(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("完成")) {
          const senderName = await getDisplayName(event.source);
          await handleCompleteTodo(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("刪除備忘")) {
          await handleDeleteNote(text.slice(4).trim(), groupId, replyToken);
        } else if (text.startsWith("改備忘")) {
          const senderName = await getDisplayName(event.source);
          await handleEditNote(text.slice(3).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("查備忘")) {
          await handleQueryNote(groupId, replyToken);
        } else if (text.startsWith("備忘")) {
          const senderName = await getDisplayName(event.source);
          await handleAddNote(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("提醒")) {
          await handleSetReminder(text.slice(2).trim(), groupId, replyToken);
        } else if (text === "說明" || text === "功能" || text.toLowerCase() === "help") {
          await replyMessage(replyToken, HELP_TEXT);
        }
      } catch (err) {
        console.error(err);
        await replyMessage(replyToken, "發生錯誤，請稍後再試 🙏");
      }
    })
  );

  res.status(200).send("OK");
});
