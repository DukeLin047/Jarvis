const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const CATEGORIES = ["餐飲", "交通", "生活用品", "醫療", "娛樂", "其他"];

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
  // 家庭群組用 groupId 當作資料範圍；私訊則用 userId 各自獨立
  return source.groupId || source.roomId || source.userId;
}

// ---------- 記帳 ----------

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

async function handleAddExpense(text, groupId, senderName, replyToken) {
  const parsed = parseExpense(text);
  if (!parsed) {
    await replyMessage(
      replyToken,
      "格式不對喔～請用:\n記帳 類別 項目 金額\n例如: 記帳 餐飲 午餐 150\n(類別可省略,會自動歸類「其他」)\n\n可用類別: " +
        CATEGORIES.join("/")
    );
    return;
  }
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  await db.collection("expenses").add({
    groupId,
    category: parsed.category,
    item: parsed.item,
    amount: parsed.amount,
    sender: senderName,
    yearMonth,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await replyMessage(
    replyToken,
    `已記帳 ✅\n${parsed.category} - ${parsed.item}\n金額: $${parsed.amount}\n記錄人: ${senderName}`
  );
}

async function handleQueryExpense(text, groupId, replyToken) {
  const arg = text.trim();
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

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
      .map((d) => `・${d.item} $${d.amount} (${d.sender})`);
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
    await replyMessage(
      replyToken,
      `${title}\n${lines.join("\n")}\n\n總計: $${total}\n\n輸入「查帳 類別」可看明細`
    );
  }
}

// ---------- 待辦 ----------

async function handleAddTodo(content, groupId, senderName, replyToken) {
  if (!content) {
    await replyMessage(replyToken, "格式: 待辦 內容\n例如: 待辦 買尿布");
    return;
  }
  await db.collection("todos").add({
    groupId,
    content,
    done: false,
    sender: senderName,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  await replyMessage(replyToken, `已加入待辦 ✅\n「${content}」\n新增人: ${senderName}`);
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
  const lines = docs.map((d, i) => `${i + 1}. ${d.content} (${d.sender})`);
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
  await replyMessage(replyToken, `已記錄備忘 ✅\n「${content}」\n記錄人: ${senderName}`);
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
  const lines = docs.map((d) => `・${d.content} (${d.sender})`);
  await replyMessage(replyToken, `📌 最近備忘\n${lines.join("\n")}`);
}

// ---------- 說明 ----------

const HELP_TEXT = `🏠 家庭小管家 使用說明

【記帳】
記帳 類別 項目 金額 (類別可省略)
查帳 / 查帳 類別

【待辦】
待辦 內容
查待辦
完成 關鍵字

【備忘】
備忘 內容
查備忘

可用類別: ${CATEGORIES.join("/")}`;

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
        if (text.startsWith("記帳")) {
          const senderName = await getDisplayName(event.source);
          await handleAddExpense(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("查帳")) {
          await handleQueryExpense(text.slice(2).trim(), groupId, replyToken);
        } else if (text.startsWith("待辦")) {
          const senderName = await getDisplayName(event.source);
          await handleAddTodo(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("查待辦")) {
          await handleQueryTodo(groupId, replyToken);
        } else if (text.startsWith("完成")) {
          const senderName = await getDisplayName(event.source);
          await handleCompleteTodo(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("備忘")) {
          const senderName = await getDisplayName(event.source);
          await handleAddNote(text.slice(2).trim(), groupId, senderName, replyToken);
        } else if (text.startsWith("查備忘")) {
          await handleQueryNote(groupId, replyToken);
        } else if (text === "說明" || text === "功能" || text.toLowerCase() === "help") {
          await replyMessage(replyToken, HELP_TEXT);
        }
      } catch (err) {
        console.error(err);
        await replyMessage(replyToken, "發生錯誤,請稍後再試 🙏");
      }
    })
  );

  res.status(200).send("OK");
});
