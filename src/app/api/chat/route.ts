import { NextResponse } from "next/server";
import Groq from "groq-sdk";
import { supabase } from "@/lib/supabaseClient";
import { embedText } from "@/lib/embeddings";
import { retrieveRelevantChunks } from "@/lib/retrieval";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

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
      return NextResponse.json(
        { error: "Embedding failed" },
        { status: 500 }
      );
    }

    /* 2️⃣ Retrieve chunks */
    const matches = await retrieveRelevantChunks(queryEmbedding, file_id, 5);
    const hasContext = matches.length > 0;
    const contextText = matches.map(m => m.chunk).join("\n\n");

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

    /* 4️⃣ STRICT SYSTEM PROMPT */
    const systemPrompt = `
You are a WhatsApp conversational assistant.

========================
LANGUAGE RULES (STRICT)
========================
You are ALLOWED to reply ONLY in:
- Hinglish (default)
- English
- Hindi (देवनागरी)
- Gujarati (ગુજરાતી)

Rules:
- Clear English → English reply
- Hindi script → Hindi reply
- Gujarati script → Gujarati reply
- Mixed / Roman Hindi / broken → Hinglish reply
- NEVER reply in any other language
- NEVER mention language detection

========================
BEHAVIOR
========================
- Professional but friendly
- Natural, human tone
- Short WhatsApp-style replies
- Light emojis allowed 😊 (no overuse)
- Never robotic or scripted

========================
KNOWLEDGE RULES
========================
- Answer ONLY using the INFORMATION section
- NEVER guess or assume
- NEVER add external knowledge
- NEVER explain limitations

FORBIDDEN WORDS:
document, documents, dataset, knowledge base, training data, source

========================
FALLBACK RULE
========================
If INFORMATION is empty or answer is not found:
- Clearly say information is not available right now
- Be polite & helpful
- Do NOT explain why
- Do NOT mention data or documents

Fallback examples:
Hinglish: "Is topic pe abhi exact info available nahi hai 😊 Aap kuch aur pooch sakte ho."
Hindi: "Is vishay par abhi jaankari uplabdh nahi hai 😊"
English: "I don’t have the right information on this yet 😊"
Gujarati: "આ વિષય પર હાલમાં ચોક્કસ માહિતી ઉપલબ્ધ નથી 😊"

========================
INFORMATION
========================
${hasContext ? contextText : "NO_INFORMATION_AVAILABLE"}
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
      temperature: 0.2,
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
