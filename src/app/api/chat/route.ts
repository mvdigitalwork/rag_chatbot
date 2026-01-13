import { NextResponse } from "next/server"; // ✅ FIXED
import Groq from "groq-sdk";
import { supabase } from "@/lib/supabaseClient";
import { embedText } from "@/lib/embeddings";
import { retrieveRelevantChunks } from "@/lib/retrieval";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

function getTodayDay() {
  return new Date().toLocaleDateString("en-US", { weekday: "long" });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { session_id, message, file_id } = body;

    if (!session_id || !message) {
      return NextResponse.json(
        { error: "session_id and message are required" },
        { status: 400 }
      );
    }

    /* 1️⃣ Embed user query */
    const queryEmbedding = await embedText(message);
    if (!queryEmbedding) {
      return NextResponse.json({ error: "Embedding failed" }, { status: 500 });
    }

    /* 2️⃣ Retrieve candidate chunks (NOT final answer) */
    const matches = await retrieveRelevantChunks(queryEmbedding, file_id, 8);

    const candidateContext = matches
      .map((m, i) => `Chunk ${i + 1}:\n${m.chunk}`)
      .join("\n\n");

    /* 3️⃣ Load chat history */
    const { data: historyRows } = await supabase
      .from("messages")
      .select("role, content")
      .eq("session_id", session_id)
      .order("created_at", { ascending: true });

    const history = (historyRows || []).map(m => ({
      role: m.role,
      content: m.content,
    }));

    const today = getTodayDay();

    /* 4️⃣ SMART SYSTEM PROMPT (MAIN FIX) */
    const systemPrompt = `
You are a smart WhatsApp conversational assistant.

TODAY IS: ${today}

========================
LANGUAGE RULES (STRICT)
========================
You can reply ONLY in:
- Hinglish
- English
- Hindi (देवनागरी)
- Gujarati (ગુજરાતી)

Rules:
- English input → English reply
- Hindi script → Hindi reply
- Gujarati script → Gujarati reply
- Mixed / Roman / casual → Hinglish reply
- NEVER reply in any other language
- NEVER mention language detection

========================
INTELLIGENCE RULE
========================
- Understand the user's intent (offer / discount / deal)
- Identify TODAY using system info
- From the information below, SELECT ONLY content relevant to TODAY
- IGNORE all other days completely
- NEVER dump full content

========================
KNOWLEDGE RULES
========================
- Use ONLY the INFORMATION below
- NEVER guess or assume
- NEVER add external knowledge

FORBIDDEN WORDS:
document, documents, dataset, knowledge base, training data, source

========================
FALLBACK RULE
========================
If TODAY's info is not available:
- Politely say info is not available 😊
- Offer help with something else
- Do NOT explain why

Fallback examples:
Hinglish: "Is topic pe abhi exact info available nahi hai 😊 Aap kuch aur pooch sakte ho."
Hindi: "Is vishay par abhi jaankari uplabdh nahi hai 😊"
English: "I don’t have the right information on this yet 😊"
Gujarati: "આ વિષય પર હાલમાં ચોક્કસ માહિતી ઉપલબ્ધ નથી 😊"

========================
INFORMATION
========================
${candidateContext || "NO_INFORMATION_AVAILABLE"}
`.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    /* 5️⃣ Stream response */
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.3,
      stream: true,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of completion) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) controller.enqueue(encoder.encode(content));
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });

  } catch (err) {
    console.error("CHAT_ERROR:", err);
    return NextResponse.json(
      { error: "Chat processing failed" },
      { status: 500 }
    );
  }
}
