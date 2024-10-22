import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// Load environment variables
dotenv.config();
const { OPENAI_API_KEY, PORT = 5050 } = process.env;

if (!OPENAI_API_KEY) {
    console.error("Missing OpenAI API key. Please set it in the .env file.");
    process.exit(1);
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Serve static files (HTML/CSS/JS for front-end UI)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log("Static file path:", path.join(__dirname, 'public'));

fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/', // Serve the static files at the root path
});

// Load configuration from config.json
const configPath = path.join(__dirname, 'config.json');
function loadConfig() {
    try {
        const data = fs.readFileSync(configPath);
        return JSON.parse(data);
    } catch (error) {
        console.error("Error loading configuration:", error);
        process.exit(1);
    }
}

function saveConfig(config) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error("Error saving configuration:", error);
    }
}

let { SYSTEM_MESSAGE, VOICE, SILENCE_TIMEOUT, THRESHOLD } = loadConfig();

const LOG_EVENT_TYPES = [
    "response.content.done",
    "rate_limits.updated",
    "response.done",
    "input_audio_buffer.committed",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.speech_started",
    "session.created",
];

let clients = [];

// WebSocket for streaming logs to the front end
fastify.register(async (fastify) => {
    fastify.get("/log-stream", { websocket: true }, (connection, _) => {
        console.log("Front-end client connected for logs");
        clients.push(connection);

        connection.socket.on("close", () => {
            console.log("Front-end client disconnected from logs");
            clients = clients.filter(client => client !== connection);
        });
    });
});

function broadcastLog(message) {
    clients.forEach(client => {
        if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify({ timestamp: new Date(), message }));
        }
    });
}

// Routes to handle config
fastify.get("/get-config", async (request, reply) => {
    const config = {
        SYSTEM_MESSAGE,
        VOICE,
        SILENCE_TIMEOUT,
        THRESHOLD,
    };
    reply.send(config);
});

fastify.post("/update-config", async (request, reply) => {
    const { system_message, voice, silence_timeout, threshold } = request.body;

    if (system_message !== undefined && system_message !== null) {
        SYSTEM_MESSAGE = system_message;
    }

    if (voice !== undefined && voice !== null) {
        VOICE = voice;
    }

    if (silence_timeout !== undefined && silence_timeout !== null) {
        SILENCE_TIMEOUT = parseInt(silence_timeout, 10);
    }

    if (threshold !== undefined && threshold !== null) {
        THRESHOLD = parseFloat(threshold);
    }

    const updatedConfig = {
        SYSTEM_MESSAGE,
        VOICE,
        SILENCE_TIMEOUT,
        THRESHOLD,
    };

    saveConfig(updatedConfig);

    broadcastLog("Updated Configuration:");
    broadcastLog(`SYSTEM_MESSAGE: ${SYSTEM_MESSAGE}`);
    broadcastLog(`VOICE: ${VOICE}`);
    broadcastLog(`SILENCE_TIMEOUT: ${SILENCE_TIMEOUT}`);
    broadcastLog(`THRESHOLD: ${THRESHOLD}`);

    reply.send({ message: "Configuration updated successfully!" });
});

fastify.all("/incoming-call", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <Stream url="wss://${request.headers.host}/media-stream" />
            </Connect>
        </Response>`;
    reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection, _) => {
        console.log("Client connected");
        broadcastLog("Client connected to media-stream");
        const openAiWs = initializeOpenAiWebSocket();
        let streamSid = null;

        // Send initial session update after connection is stable
        openAiWs.on("open", () => {
            console.log("Connected to OpenAI Realtime API");
            broadcastLog("Connected to OpenAI Realtime API");
            setTimeout(() => sendSessionUpdate(openAiWs), 250);
        });

        // OpenAI WebSocket message handler
        openAiWs.on("message", (data) =>
            handleOpenAiMessage(openAiWs, data, connection, streamSid),
        );

        // Handle incoming messages from Twilio WebSocket
        connection.on("message", (message) =>
            handleTwilioMessage(message, openAiWs, (sid) => (streamSid = sid)),
        );

        // Clean up on connection close
        connection.on("close", () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log("Client disconnected.");
            broadcastLog("Client disconnected from media-stream");
        });

        // Handle OpenAI WebSocket close and error events
        openAiWs.on("close", () => {
            console.log("Disconnected from OpenAI Realtime API");
            broadcastLog("Disconnected from OpenAI Realtime API");
        });
        openAiWs.on("error", (error) => {
            console.error("OpenAI WebSocket error:", error);
            broadcastLog(`OpenAI WebSocket error: ${error}`);
        });
    });
});

// Function to initialize OpenAI WebSocket
function initializeOpenAiWebSocket() {
    return new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        },
    );
}

// Function to send session update to OpenAI WebSocket
function sendSessionUpdate(ws) {
    const sessionUpdate = {
        type: "session.update",
        session: {
            turn_detection: {
                type: "server_vad",
                threshold: THRESHOLD,
                silence_duration_ms: SILENCE_TIMEOUT
            },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            voice: VOICE,
            instructions: SYSTEM_MESSAGE,
            tools: [
                {
                    type: "function",
                    name: "suggest_breathing_exercise",
                    description: "Suggest a simple breathing exercise to help the user relax",
                    parameters: {
                        type: "object",
                        properties: {
                            duration: {
                                type: "integer",
                                description: "Duration of the exercise in seconds"
                            }
                        }
                    }
                }
            ],
            modalities: ["text", "audio"],
            temperature: 0.7,
        },
    };
    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    broadcastLog("Sending session update: " + JSON.stringify(sessionUpdate));
    ws.send(JSON.stringify(sessionUpdate));
}

// Handle messages from OpenAI WebSocket
function handleOpenAiMessage(openAiWs, data, connection, streamSid) {
    try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
            console.log(`Received event: ${response.type}`, response);
            broadcastLog(`Received event: ${response.type}, Data: ${JSON.stringify(response)}`);
        }

        if (response.type === "session.updated") {
            console.log("Session updated successfully:", response);
            broadcastLog("Session updated successfully: " + JSON.stringify(response));
        }

        if (response.type === "response.function_call_arguments.done") {
            console.log("FUNCTION CALLED successfully:", response);
            broadcastLog("FUNCTION CALLED successfully: " + JSON.stringify(response));

            // Handle breathing exercise suggestion
            const functionArgs = JSON.parse(response.arguments);
            const duration = functionArgs.duration || 30; // Default to 30 seconds if not specified
            const breathingExercise = `Here's a simple ${duration}-second breathing exercise: Breathe in slowly for 4 seconds, hold for 4 seconds, then exhale for 4 seconds. Repeat this cycle for the duration of the exercise.`;

            // Send function call output back to OpenAI
            openAiWs.send(
                JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        output: breathingExercise,
                    },
                }),
            );

            openAiWs.send(
                JSON.stringify({
                    type: "response.create",
                    response: {
                        modalities: ["text", "audio"],
                        instructions: `Guide the user through the following breathing exercise: ${breathingExercise}`,
                    },
                }),
            );

            console.log("Breathing exercise suggestion triggered");
            broadcastLog("Breathing exercise suggestion triggered");
        }

        if (response.type === "response.audio.delta" && response.delta) {
            const audioDelta = {
                event: "media",
                streamSid: streamSid,
                media: {
                    payload: Buffer.from(response.delta, "base64").toString(
                        "base64",
                    ),
                },
            };
            connection.send(JSON.stringify(audioDelta));
        }
    } catch (error) {
        console.error(
            "Error processing OpenAI message:",
            error,
            "Raw message:",
            data,
        );
        broadcastLog(`Error processing OpenAI message: ${error}, Raw message: ${data}`);
    }
}

// Handle messages from Twilio WebSocket
function handleTwilioMessage(message, openAiWs, setStreamSid) {
    try {
        const data = JSON.parse(message);

        switch (data.event) {
            case "media":
                if (openAiWs.readyState === WebSocket.OPEN) {
                    const audioAppend = {
                        type: "input_audio_buffer.append",
                        audio: data.media.payload,
                    };
                    openAiWs.send(JSON.stringify(audioAppend));
                }
                break;
            case "start":
                setStreamSid(data.start.streamSid);
                console.log("Incoming stream started:", data.start.streamSid);
                broadcastLog("Incoming stream started: " + data.start.streamSid);
                break;
            default:
                console.log("Received non-media event:", data.event);
                broadcastLog("Received non-media event: " + data.event);
                break;
        }
    } catch (error) {
        console.error(
            "Error parsing Twilio message:",
            error,
            "Message:",
            message,
        );
        broadcastLog(`Error parsing Twilio message: ${error}, Message: ${message}`);
    }
}

// Start the server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Business Coach AI Server is listening on port ${PORT}`);
    broadcastLog(`Business Coach AI Server is listening on port ${PORT}`);
});