"""Minimal ACP mock used by the Node end-to-end question round-trip test.

The sandbox used for CI suppresses nested Node subprocesses, so this fixture is
implemented in Python. It exercises the same stdio JSON-RPC path as the Qwen
dialect mock in mock-agent.mjs.
"""

import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def reply(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def permission_request(session_id):
    request_id = 1000
    send({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "session/request_permission",
        "params": {
            "sessionId": session_id,
            "toolCall": {
                "toolCallId": "call-1",
                "title": "Please answer the following question(s):",
                "kind": "other",
                "_meta": {
                    "toolName": "ask_user_question",
                    "qwenInteractionKind": "user_question",
                    "qwenQuestions": [
                        {
                            "header": "Mount type",
                            "question": "Which mount style should I design?",
                            "options": [
                                {"label": "Clamp-on", "description": "Grips the desk edge, no drilling."},
                                {"label": "Bolt-through", "description": "Stronger, needs a hole."},
                            ],
                            "multiSelect": False,
                        },
                        {
                            "header": "Material",
                            "question": "Which materials should it target?",
                            "options": [
                                {"label": "PLA", "description": "Easy to print."},
                                {"label": "PETG", "description": "Tougher, more heat resistant."},
                            ],
                            "multiSelect": True,
                        },
                    ],
                },
            },
            "options": [
                {"optionId": "proceed_once", "name": "Submit", "kind": "allow_once"},
                {"optionId": "cancel", "name": "Cancel", "kind": "reject_once"},
            ],
        },
    })

    while True:
        line = sys.stdin.readline()
        if not line:
            return None
        message = json.loads(line)
        if message.get("id") == request_id and "method" not in message:
            return message.get("result")


for raw_line in sys.stdin:
    if not raw_line.strip():
        continue
    message = json.loads(raw_line)
    method = message.get("method")

    if method == "initialize":
        reply(message["id"], {
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": False},
            "authMethods": [],
        })
    elif method == "session/new":
        reply(message["id"], {"sessionId": "mock-session-1"})
    elif method == "session/prompt":
        session_id = message["params"]["sessionId"]
        notify("session/update", {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Let me check a couple of things.\n"},
            },
        })
        notify("session/update", {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "AskUserQuestion",
                "kind": "other",
                "status": "in_progress",
                "_meta": {"toolName": "ask_user_question"},
            },
        })
        result = permission_request(session_id)
        sys.stderr.write(f"PERMISSION_RESULT:{json.dumps(result)}\n")
        sys.stderr.flush()
        reply(message["id"], {"stopReason": "end_turn"})
    elif method == "session/cancel":
        reply(message["id"], {})
