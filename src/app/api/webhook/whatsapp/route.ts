import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generateAutoResponse } from "@/lib/autoResponder";
import { transcribeAudioFromUrl } from "@/lib/speechToText";

/**
 * WhatsApp Webhook Payload (extended for voice)
 */
type WhatsAppWebhookPayload = {
    messageId: string;
    channel: string;
    from: string;
    to: string;
    receivedAt: string;
    content: {
        contentType: "text" | "audio";
        text?: string;
        mediaUrl?: string; // 👈 for voice messages
    };
    whatsapp?: {
        senderName?: string;
    };
    timestamp: string;
    event: "MoMessage" | "MtMessage";
    isin24window?: boolean;
    isResponded?: boolean;
    UserResponse?: string;
};

export async function POST(req: Request) {
    try {
        const payload: WhatsAppWebhookPayload = await req.json();

        console.log("📩 Received WhatsApp webhook:", payload);

        // Basic validation
        if (!payload.messageId || !payload.from || !payload.to) {
            return NextResponse.json(
                { error: "Missing required fields: messageId, from, or to" },
                { status: 400 }
            );
        }

        let finalUserText: string | null = null;
        let transcription: string | null = null;

        /* --------------------------------------------------
           📝 TEXT MESSAGE
        -------------------------------------------------- */
        if (payload.content?.contentType === "text") {
            finalUserText =
                payload.content.text ||
                payload.UserResponse ||
                null;
        }

        /* --------------------------------------------------
           🎤 VOICE MESSAGE
        -------------------------------------------------- */
        if (payload.content?.contentType === "audio") {
            const mediaUrl = payload.content.mediaUrl;

            if (!mediaUrl) {
                console.error("❌ Audio message without mediaUrl");
                return NextResponse.json({ success: true });
            }

            console.log("🎧 Voice message detected, transcribing...");

            transcription = await transcribeAudioFromUrl(mediaUrl);

            if (!transcription) {
                console.error("❌ Voice transcription failed");
                return NextResponse.json({ success: true });
            }

            finalUserText = transcription;
            console.log("📝 Transcription:", transcription);
        }

        /* --------------------------------------------------
           🗄️ STORE MESSAGE IN DATABASE
        -------------------------------------------------- */
        const { error: insertError } = await supabase
            .from("whatsapp_messages")
            .insert([
                {
                    message_id: payload.messageId,
                    channel: payload.channel,
                    from_number: payload.from,
                    to_number: payload.to,
                    received_at: payload.receivedAt,
                    content_type: payload.content?.contentType,
                    content_text: finalUserText,
                    sender_name: payload.whatsapp?.senderName,
                    event_type: payload.event,
                    is_in_24_window: payload.isin24window || false,
                    is_responded: payload.isResponded || false,
                    raw_payload: {
                        ...payload,
                        transcription,
                    },
                },
            ]);

        if (insertError) {
            // Duplicate message safeguard
            if (insertError.code === "23505") {
                return NextResponse.json({
                    success: true,
                    duplicate: true,
                    message: "Message already processed",
                });
            }
            throw insertError;
        }

        /* --------------------------------------------------
           🤖 AUTO RESPONSE (ONLY USER → BUSINESS)
        -------------------------------------------------- */
        if (finalUserText && payload.event === "MoMessage") {
            console.log("🤖 Generating auto response...");

            const result = await generateAutoResponse(
                payload.from, // customer
                payload.to,   // business number
                finalUserText,
                payload.messageId
            );

            if (result.success) {
                console.log("✅ Auto-response sent successfully");
            } else {
                console.error("❌ Auto-response failed:", result.error);
            }
        }

        return NextResponse.json({
            success: true,
            message: "WhatsApp webhook processed successfully",
        });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("🔥 WEBHOOK_ERROR:", message, err);
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}

/* --------------------------------------------------
   🔐 WEBHOOK VERIFICATION (UNCHANGED)
-------------------------------------------------- */
export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge");

    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!;

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verified");
        return new Response(challenge, { status: 200 });
    }

    return NextResponse.json(
        { error: "Verification failed" },
        { status: 403 }
    );
}
