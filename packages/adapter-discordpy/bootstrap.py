"""Run a discord.py Bot against one local DisRunner session."""

import os
import re
import runpy
import sys
import json
import logging
import functools
import traceback
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from urllib.parse import urlsplit


SDK_VERSION = "2.6.4"
active_handlers = set()
handler_sequence = 0
handler_capacity_reported = False
bot_entry_started = False


def sensitive_environment_values():
    values = [value for key, value in os.environ.items() if value and re.search(
        r"(?:^|_)(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION|CREDENTIAL)$",
        key, re.IGNORECASE,
    )]
    sizes = [len(value.encode("utf-8", errors="replace")) for value in values]
    if len(values) > 512 or any(size > 65536 for size in sizes) or sum(sizes) > 2097152:
        return None
    variants = set()
    for value in values:
        variants.add(value)
        variants.add(json.dumps(value, ensure_ascii=False)[1:-1])
        variants.add(json.dumps(value, ensure_ascii=True)[1:-1])
    return variants


diagnostic_secrets = sensitive_environment_values()


def redact_diagnostic(source):
    value = str(source)
    if diagnostic_secrets is None or len(value.encode("utf-8", errors="replace")) > 1048576:
        return "[Diagnostic content omitted: redaction limit exceeded.]"
    matches = []
    for secret in diagnostic_secrets:
        offset = 0
        while True:
            start = value.find(secret, offset)
            if start == -1:
                break
            if len(matches) >= 8192:
                return "[Diagnostic content omitted: redaction limit exceeded.]"
            matches.append((start, start + len(secret)))
            offset = start + 1
    matches.sort(key=lambda match: (match[0], -match[1]))
    cursor = 0
    parts = []
    for start, end in matches:
        if start >= cursor:
            parts.extend((value[cursor:start], "[REDACTED]"))
        cursor = max(cursor, end)
    parts.append(value[cursor:])
    return "".join(parts)


def emit_diagnostic(source, code="bot-error", prefix="DISRUNNER_DIAGNOSTIC"):
    lines = redact_diagnostic(source).splitlines()
    selected = []
    size = 0
    for line in reversed(lines):
        length = len(line.encode("utf-8", errors="replace")) + 1
        if length > 1000:
            selected.append("[Long diagnostic line omitted.]")
            break
        if size + length > 1000:
            selected.append("[Additional diagnostic lines omitted.]")
            break
        selected.append(line)
        size += length
    message = "\n".join(reversed(selected)) or "The Bot reported an error."
    payload = json.dumps({"code": code, "message": message}, ensure_ascii=False, separators=(",", ":"))
    frame = (prefix + " " + payload + "\n").encode("utf-8", errors="replace")
    if len(frame) > 4096:
        payload = json.dumps({"code": code, "message": "The error message exceeded the diagnostic limit."}, separators=(",", ":"))
        frame = (prefix + " " + payload + "\n").encode("utf-8")
    os.write(1, frame)


def begin_handler():
    global handler_sequence, handler_capacity_reported
    if len(active_handlers) >= 1000:
        if not handler_capacity_reported:
            emit_diagnostic("The active handler limit of 1,000 was exceeded.")
            handler_capacity_reported = True
        return None
    while True:
        handler_sequence = (handler_sequence + 1) & ((1 << 64) - 1)
        handler_id = f"py-{os.getpid()}-{handler_sequence}"
        if handler_id not in active_handlers:
            break
    active_handlers.add(handler_id)
    os.write(1, ("DISRUNNER_HANDLER " + json.dumps({"id": handler_id, "phase": "start"}, separators=(",", ":")) + "\n").encode("ascii"))
    return handler_id


def end_handler(handler_id):
    if handler_id is None or handler_id not in active_handlers:
        return
    active_handlers.remove(handler_id)
    os.write(1, ("DISRUNNER_HANDLER " + json.dumps({"id": handler_id, "phase": "end"}, separators=(",", ":")) + "\n").encode("ascii"))


def track_async(owner, name):
    original = getattr(owner, name)

    @functools.wraps(original)
    async def tracked(*args, **kwargs):
        handler_id = begin_handler()
        try:
            return await original(*args, **kwargs)
        finally:
            end_handler(handler_id)

    setattr(owner, name, tracked)


def track_timeout_dispatch(owner):
    original = owner._dispatch_timeout
    missing = object()

    @functools.wraps(original)
    def dispatch(view):
        callback = view.on_timeout
        previous = vars(view).get("on_timeout", missing)

        @functools.wraps(callback)
        async def tracked():
            handler_id = begin_handler()
            try:
                return await callback()
            except Exception as error:
                emit_diagnostic("".join(traceback.format_exception(error)))
                raise
            finally:
                end_handler(handler_id)

        # The pinned SDK creates the timeout task synchronously. Restore the
        # public callback before that task runs, retaining the SDK's lifecycle.
        view.on_timeout = tracked
        try:
            return original(view)
        finally:
            if previous is missing:
                del view.on_timeout
            else:
                view.on_timeout = previous

    owner._dispatch_timeout = dispatch


class DiagnosticHandler(logging.Handler):
    def emit(self, record):
        try:
            if getattr(record, "_disrunner_reported", False):
                return
            record._disrunner_reported = True
            emit_diagnostic(self.format(record))
        except Exception:
            # Preserve the SDK's existing logging and exception behavior.
            pass


def endpoint(value, scheme, label):
    url = urlsplit(value or "")
    if (
        url.scheme != scheme
        or url.hostname not in ("127.0.0.1", "::1", "localhost")
        or not url.port
        or url.username
        or url.password
        or url.fragment
    ):
        raise RuntimeError(f"{label} must be a loopback URL with an explicit port.")
    return url


def main():
    global bot_entry_started
    if len(sys.argv) < 2 or not Path(sys.argv[1]).is_absolute():
        raise RuntimeError("The discord.py adapter requires an absolute Bot entry point.")
    entry = Path(sys.argv[1])
    if os.environ.get("DISRUNNER_OFFLINE") != "1":
        raise RuntimeError("The discord.py adapter must be started by an offline DisRunner session.")
    fake_token = os.environ.get("DISRUNNER_FAKE_TOKEN", "")
    if not re.fullmatch(r"disrunner\.offline\.[A-Za-z0-9_-]{16,256}", fake_token):
        raise RuntimeError("A synthetic DisRunner session credential is required.")
    api = endpoint(os.environ.get("DISCORD_API_BASE_URL"), "http", "REST endpoint")
    if not api.path.endswith("/api/v10") or api.query:
        raise RuntimeError("The REST endpoint must use API v10.")
    gateway = endpoint(os.environ.get("DISCORD_GATEWAY_URL"), "ws", "Gateway endpoint")
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("This discord.py adapter requires Python 3.12.")
    sys.path.insert(0, str(entry.parent))
    try:
        installed = version("discord.py")
    except PackageNotFoundError as error:
        raise RuntimeError(
            f"Install discord.py {SDK_VERSION} in the selected Python environment before running offline."
        ) from error
    if installed != SDK_VERSION:
        raise RuntimeError(
            f"Unsupported discord.py version {installed}; this adapter requires {SDK_VERSION}."
        )
    try:
        import aiohttp
        import discord
        import discord.gateway
        import discord.http
        import yarl
    except ImportError as error:
        raise RuntimeError(
            f"Install discord.py {SDK_VERSION} in the selected Python environment before running offline."
        ) from error
    if discord.__version__ != SDK_VERSION:
        raise RuntimeError(
            "The imported discord.py module does not match its installed package metadata."
        )
    diagnostic_handler = DiagnosticHandler(level=logging.ERROR)
    for name in ("discord", "discord.app_commands.tree", "discord.client", "discord.ext.commands.bot", "discord.ui.view", "discord.ui.modal"):
        logging.getLogger(name).addHandler(diagnostic_handler)
    track_async(discord.Client, "_run_event")
    track_async(discord.app_commands.CommandTree, "_call")
    track_async(discord.ui.View, "_scheduled_task")
    track_async(discord.ui.Modal, "_scheduled_task")
    track_timeout_dispatch(discord.ui.view.BaseView)

    discord.http.Route.BASE = api.geturl().rstrip("/")
    discord.gateway.DiscordWebSocket.DEFAULT_GATEWAY = yarl.URL(gateway.geturl())
    original_request = aiohttp.ClientSession._request

    async def local_request(session, method, url, **kwargs):
        target = urlsplit(str(url))
        expected = gateway if target.scheme == "ws" else api
        if (
            target.scheme != expected.scheme
            or target.hostname != expected.hostname
            or target.port != expected.port
        ):
            raise RuntimeError("The offline adapter rejected a connection outside this session.")
        attachment = target.scheme == "http" and re.fullmatch(r"/attachments/[1-9][0-9]{0,19}", target.path)
        if target.scheme == "http" and not target.path.startswith(api.path + "/"):
            if not attachment or method.upper() != "GET":
                raise RuntimeError("The offline adapter rejected a request outside API v10.")
        if attachment:
            kwargs["headers"] = {**kwargs.get("headers", {}), "Authorization": "Bot " + fake_token}
        kwargs.pop("proxy", None)
        kwargs.pop("proxy_auth", None)
        kwargs["allow_redirects"] = False
        return await original_request(session, method, url, **kwargs)

    aiohttp.ClientSession._request = local_request
    original_login = discord.Client.login
    original_dispatch = discord.Client.dispatch

    async def login_offline(client, token=None):
        del token
        return await original_login(client, fake_token)

    def dispatch_offline(client, event, *args, **kwargs):
        result = original_dispatch(client, event, *args, **kwargs)
        if event == "ready":
            client.loop.call_soon(lambda: print("DISRUNNER_ADAPTER_READY", flush=True))
        return result

    discord.Client.login = login_offline
    discord.Client.dispatch = dispatch_offline
    sys.argv = [str(entry), *sys.argv[2:]]
    bot_entry_started = True
    runpy.run_path(str(entry), run_name="__main__")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if not bot_entry_started:
            emit_diagnostic(str(error), code="unsupported", prefix="DISRUNNER_ADAPTER_ERROR")
        else:
            emit_diagnostic("".join(traceback.format_exception(error)))
        print(f"DisRunner discord.py adapter: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1) from error
