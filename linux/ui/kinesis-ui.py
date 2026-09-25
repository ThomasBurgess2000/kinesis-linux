#!/usr/bin/env python3
"""Kinesis tray app: a system-tray icon and a Kirigami window for the kinesis daemon.

The daemon (`kinesis daemon`, usually the kinesis.service user unit) owns the band. This process
only draws it: it talks to the daemon over $XDG_RUNTIME_DIR/kinesis/daemon.sock (newline-delimited
JSON), so the UI can close or crash without dropping the band.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import Property, QObject, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QAction, QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuick import QQuickWindow  # noqa: F401 (so the root object comes back as a QQuickWindow)
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon
import shiboken6

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FACTORY_RESET_URL = "https://www.meta.com/help/ai-glasses/1481163499576351/"
AUTOSTART = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "autostart" / "kinesis.desktop"


def socket_path() -> str:
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/tmp/kinesis-{os.getuid()}"
    return os.path.join(runtime, "kinesis", "daemon.sock")


def systemctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, check=False)


class Daemon(QObject):
    """The daemon's state, config, and methods, as properties and slots for QML and the tray."""

    stateChanged = Signal()
    configChanged = Signal()
    catalogChanged = Signal()
    linkChanged = Signal()
    doctorChanged = Signal()
    startAtLoginChanged = Signal()
    gesture = Signal("QVariantMap")
    action = Signal("QVariantMap")
    dial = Signal(float)
    pairing = Signal("QVariantMap")
    requestFailed = Signal(str)
    showWindowRequested = Signal()

    def __init__(self, path: str, start_service: bool = True):
        super().__init__()
        self._path = path
        self._start_service = start_service
        self._state: dict = {}
        self._config: dict = {}
        self._catalog: dict = {"actions": [], "swipes": [], "taps": [], "dialTargets": []}
        self._doctor: list = []
        self._link = False
        self._next_id = 1
        self._callbacks: dict = {}
        self._buffer = b""
        self._tried_service = False
        self._retry_ms = 500
        self._socket = QLocalSocket(self)
        self._socket.connected.connect(self._on_connected)
        self._socket.disconnected.connect(self._on_lost)
        self._socket.errorOccurred.connect(self._on_error)
        self._socket.readyRead.connect(self._read)
        self._retry = QTimer(self, singleShot=True)
        self._retry.timeout.connect(self.reconnect)

    # --- connection ---

    @Slot()
    def reconnect(self) -> None:
        if self._socket.state() == QLocalSocket.LocalSocketState.UnconnectedState:
            self._socket.connectToServer(self._path)

    @Slot()
    def startService(self) -> None:
        subprocess.Popen(["systemctl", "--user", "start", "kinesis.service"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self._retry.start(800)

    def _on_connected(self) -> None:
        self._retry_ms = 500
        self._set_link(True)
        self.call("getState", {}, self._take_state)
        self.call("getConfig", {}, self._take_config)
        self.call("listActions", {}, self._take_catalog)

    def _on_lost(self) -> None:
        self._set_link(False)
        self._retry.start(self._retry_ms)

    def _on_error(self, _error) -> None:
        if self._socket.state() != QLocalSocket.LocalSocketState.UnconnectedState:
            return
        # No daemon yet: start the user service once, then keep retrying with a gentle backoff.
        if self._start_service and not self._tried_service:
            self._tried_service = True
            self.startService()
            return
        self._set_link(False)
        self._retry_ms = min(self._retry_ms * 2, 5000)
        self._retry.start(self._retry_ms)

    def _set_link(self, link: bool) -> None:
        if self._link != link:
            self._link = link
            self.linkChanged.emit()
            self.stateChanged.emit()

    def call(self, method: str, params: dict, callback=None) -> None:
        if self._socket.state() != QLocalSocket.LocalSocketState.ConnectedState:
            if self._link:  # --check fixture: there's no daemon to ask
                return
            self.requestFailed.emit("Kinesis isn't running.")
            return
        request_id = self._next_id
        self._next_id += 1
        if callback:
            self._callbacks[request_id] = callback
        self._socket.write((json.dumps({"id": request_id, "method": method, "params": params}) + "\n").encode())

    def _read(self) -> None:
        self._buffer += bytes(self._socket.readAll())
        while b"\n" in self._buffer:
            line, self._buffer = self._buffer.split(b"\n", 1)
            if not line.strip():
                continue
            message = json.loads(line)
            if "event" in message:
                self._event(message["event"], message.get("data"))
                continue
            callback = self._callbacks.pop(message.get("id"), None)
            if message.get("error"):
                self.requestFailed.emit(message["error"])
            elif callback:
                callback(message.get("result"))

    def _event(self, name: str, data) -> None:
        if name == "state":
            self._take_state(data)
        elif name == "config":
            self._take_config(data)
        elif name == "gesture":
            self.gesture.emit(data)
        elif name == "action":
            self.action.emit(data)
        elif name == "dial":
            self.dial.emit(float(data.get("delta", 0)))
        elif name == "pairing":
            self._state = {**self._state, "pairing": data}
            self.pairing.emit(data)
            self.stateChanged.emit()

    def _take_state(self, state) -> None:
        if isinstance(state, dict):
            self._state = state
            self.stateChanged.emit()

    def _take_config(self, config) -> None:
        if isinstance(config, dict):
            self._config = config
            self.configChanged.emit()

    def _take_catalog(self, catalog) -> None:
        if isinstance(catalog, dict):
            self._catalog = catalog
            self.catalogChanged.emit()

    def _take_doctor(self, rows) -> None:
        if isinstance(rows, list):
            self._doctor = rows
            self.doctorChanged.emit()

    def load_fixture(self, fixture: dict) -> None:
        """--check: canned daemon data so every binding evaluates without a daemon."""
        self._link = True
        self._take_state(fixture["state"])
        self._take_config(fixture["config"])
        self._take_catalog(fixture["catalog"])
        self._take_doctor(fixture["doctor"])
        self.linkChanged.emit()

    # --- properties for QML ---

    def _get_state(self) -> dict:
        return self._state

    def _get_config(self) -> dict:
        return self._config

    def _get_catalog(self) -> dict:
        return self._catalog

    def _get_doctor(self) -> list:
        return self._doctor

    def _get_link(self) -> bool:
        return self._link

    def _get_next_step(self) -> dict:
        return next_step(self._link, self._state)

    def _get_start_at_login(self) -> bool:
        return AUTOSTART.exists() and systemctl("is-enabled", "kinesis.service").stdout.strip() == "enabled"

    state = Property("QVariantMap", _get_state, notify=stateChanged)
    config = Property("QVariantMap", _get_config, notify=configChanged)
    catalog = Property("QVariantMap", _get_catalog, notify=catalogChanged)
    doctor = Property("QVariantList", _get_doctor, notify=doctorChanged)
    link = Property(bool, _get_link, notify=linkChanged)
    nextStep = Property("QVariantMap", _get_next_step, notify=stateChanged)
    startAtLogin = Property(bool, _get_start_at_login, notify=startAtLoginChanged)
    factoryResetUrl = Property(str, lambda self: FACTORY_RESET_URL, constant=True)

    # --- actions for QML and the tray ---

    @Slot()
    def doNextStep(self) -> None:
        step = self._get_next_step()["id"]
        if step == "connect":
            self.call("connect", {})
        elif step == "enable":
            self.setControls(True)
        elif step == "pause":
            self.setControls(False)
        elif step == "pair":
            self.showWindowRequested.emit()

    @Slot()
    def connectBand(self) -> None:
        self.call("connect", {})

    @Slot()
    def disconnectBand(self) -> None:
        self.call("disconnect", {})

    @Slot(bool)
    def setControls(self, enabled: bool) -> None:
        self.call("setControls", {"enabled": enabled})

    @Slot(str)
    def selectHand(self, hand: str) -> None:
        self.call("selectHand", {"hand": hand})

    @Slot("QVariantMap")
    def setConfig(self, patch: dict) -> None:
        self.call("setConfig", {"patch": patch}, self._take_config)

    @Slot(bool)
    def pairBand(self, force_login: bool) -> None:
        self.call("pairBand", {"forceLogin": force_login})

    @Slot()
    def cancelPairing(self) -> None:
        self.call("cancelPairing", {})

    @Slot()
    def signOut(self) -> None:
        self.call("signOut", {})

    @Slot()
    def forget(self) -> None:
        self.call("forget", {})

    @Slot(str)
    def testAction(self, action: str) -> None:
        self.call("testAction", {"action": action})

    @Slot()
    def refreshDoctor(self) -> None:
        self.call("doctor", {}, self._take_doctor)

    @Slot(bool)
    def setStartAtLogin(self, enabled: bool) -> None:
        """Start the daemon (user unit) and this tray app when you log in."""
        if enabled:
            AUTOSTART.parent.mkdir(parents=True, exist_ok=True)
            AUTOSTART.write_text(autostart_entry())
            systemctl("enable", "kinesis.service")
        else:
            AUTOSTART.unlink(missing_ok=True)
            systemctl("disable", "kinesis.service")
        self.startAtLoginChanged.emit()

    @Slot()
    def openBluetoothSettings(self) -> None:
        subprocess.Popen(["systemsettings", "kcm_bluetooth"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def next_step(link: bool, state: dict) -> dict:
    """The one next thing to do, shared by the tray menu and the band column (as on the Mac)."""
    if not link or not state:
        return {"id": "none", "title": "Kinesis isn't running", "enabled": False}
    controller = state.get("controller", {})
    if state.get("pairing", {}).get("active"):
        return {"id": "pairing", "title": "Pairing…", "enabled": False}
    if not state.get("band") or not state.get("enrolled"):
        return {"id": "pair", "title": "Pair band…", "enabled": True}
    if controller.get("status") == "asleep":
        return {"id": "asleep", "title": "Computer is asleep", "enabled": False}
    if controller.get("status") == "disconnecting":
        return {"id": "disconnecting", "title": "Disconnecting…", "enabled": False}
    if not state.get("wantsConnection"):
        return {"id": "connect", "title": "Connect", "enabled": True}
    if not controller.get("live"):
        return {"id": "connecting", "title": "Connecting…", "enabled": False}
    if controller.get("controlsEnabled"):
        return {"id": "pause", "title": "Pause controls", "enabled": True}
    return {"id": "enable", "title": "Enable controls", "enabled": True}


def autostart_entry() -> str:
    """The same login entry packaging/install.sh writes, from the shared template."""
    return (REPO / "packaging" / "kinesis-autostart.desktop").read_text().replace("@REPO@", str(REPO))


class Tray:
    """The system-tray icon and its menu, like the Mac app's menu-bar dropdown."""

    def __init__(self, daemon: Daemon, toggle_window, quit_app):
        self.daemon = daemon
        self.active = QIcon(str(HERE / "icons" / "kinesis.svg"))
        self.inactive = QIcon(str(HERE / "icons" / "kinesis-inactive.svg"))
        self.icon = QSystemTrayIcon(self.inactive)
        self.menu = QMenu()
        self.status = self.menu.addAction("")
        self.status.setEnabled(False)
        self.battery = self.menu.addAction("")
        self.battery.setEnabled(False)
        self.menu.addSeparator()
        self.step = self.menu.addAction("", daemon.doNextStep)
        self.disconnect = self.menu.addAction("Disconnect", daemon.disconnectBand)
        self.menu.addSeparator()
        self.menu.addAction(QIcon.fromTheme("configure"), "Open Kinesis", toggle_window)
        self.menu.addAction(QIcon.fromTheme("application-exit"), "Quit Kinesis", quit_app)
        self.icon.setContextMenu(self.menu)
        self.icon.activated.connect(lambda reason: toggle_window() if reason == QSystemTrayIcon.ActivationReason.Trigger else None)
        daemon.stateChanged.connect(self.update)
        self.update()
        self.icon.show()

    def update(self) -> None:
        state = self.daemon.state
        controller = state.get("controller", {}) if state else {}
        band = (state.get("band") or {}).get("name") if state else None
        if not self.daemon.link:
            status = "Kinesis isn't running"
        elif not band:
            status = "No band yet"
        else:
            status = f"{band} · {controller.get('phase', '')}"
        self.status.setText(status)
        battery = controller.get("battery")
        self.battery.setVisible(battery is not None)
        if battery is not None:
            self.battery.setText(f"Battery {battery}%" + (" · charging" if controller.get("charging") else ""))
        step = self.daemon.nextStep
        self.step.setText(step["title"])
        self.step.setEnabled(step["enabled"])
        self.step.setVisible(step["id"] != "none")
        self.disconnect.setVisible(bool(state.get("wantsConnection")) if state else False)
        live = bool(controller.get("live") and controller.get("controlsEnabled"))
        self.icon.setIcon(self.active if live else self.inactive)
        self.icon.setToolTip(f"Kinesis — {status}")


def check_fixture() -> dict:
    """Representative daemon data for the offscreen smoke test."""
    actions = {"none": "No action", "previousDesktop": "Previous desktop", "nextDesktop": "Next desktop", "overview": "Overview",
               "dismiss": "Dismiss (Escape)", "playPause": "Play / pause", "mute": "Mute / unmute", "volumeUp": "Volume up",
               "volumeDown": "Volume down"}
    taps = {"indexTap": "Index tap", "indexDoubleTap": "Index double tap", "middleTap": "Middle tap", "middleDoubleTap": "Middle double tap",
            "middleHold": "Middle hold"}
    return {
        "state": {
            "controller": {"phase": "Connected", "status": "connected", "live": True, "controlsEnabled": True, "battery": 92,
                           "charging": False, "bandHand": "right", "handConfirmed": True, "pendingHand": None,
                           "handSettingError": None, "lastGesture": "Swipe left", "lastAction": "Sent: Previous desktop",
                           "gestureCount": 12, "dialEngaged": False, "pinchedFinger": None, "error": None,
                           "streamHint": "The sensor stream is quiet. Is the band on your wrist and off the charger?",
                           "linkCongested": False, "awaitingSystemPairing": False},
            "canChangeHand": True, "wantsConnection": True,
            "band": {"address": "AA:BB:CC:DD:EE:FF", "addressType": "public", "name": "Meta Band XXXX"},
            "enrolled": True, "metaUser": "42", "backend": "kde",
            "pairing": {"active": False, "step": None, "message": "", "url": None, "error": None, "failedStep": None,
                        "wrongAccount": False},
            "setupDone": True, "startAutomatically": True,
        },
        "config": {"swipes": {"left": "previousDesktop", "right": "nextDesktop", "up": "overview", "down": "dismiss"},
                   "taps": {"indexTap": "none", "indexDoubleTap": "playPause", "middleTap": "none", "middleDoubleTap": "mute", "middleHold": "none"},
                   "dial": {"target": "volume", "sensitivity": 1}, "setupDone": True, "startAutomatically": True},
        "catalog": {"actions": [{"id": a, "title": t, "supported": True} for a, t in actions.items()],
                    "swipes": [{"id": d, "title": f"Swipe {d}"} for d in ["left", "right", "up", "down"]],
                    "taps": [{"id": t, "title": title} for t, title in taps.items()],
                    "dialTargets": [{"id": "none", "title": "No action"}, {"id": "volume", "title": "Volume"},
                                    {"id": "brightness", "title": "Brightness"}]},
        "doctor": [{"name": "KDE backend", "ok": True, "detail": "qdbus found"}, {"name": "ydotool", "ok": False, "detail": "optional"}],
    }


def run_check(engine: QQmlApplicationEngine, app: QApplication, daemon: Daemon, warnings: list, shots: str | None) -> int:
    """Load the window offscreen, visit every page and wizard step, and fail on any QML warning.
    With --screenshots DIR, also save a PNG of each view for a visual review."""
    fixture = check_fixture()
    catalog = fixture.pop("catalog")
    daemon.load_fixture({**fixture, "catalog": {"actions": [], "swipes": [], "taps": [], "dialTargets": []}})
    engine.load(QUrl.fromLocalFile(str(HERE / "qml" / "Main.qml")))
    if not engine.rootObjects():
        print("Main.qml failed to load", file=sys.stderr)
        return 1
    window = engine.rootObjects()[0]
    window.show()
    # As with the real daemon, the action catalog arrives after the window is built.
    app.processEvents()
    daemon._take_catalog(catalog)

    def settle_and_shoot(name: str) -> None:
        for _ in range(20):
            app.processEvents()
        if shots:
            Path(shots).mkdir(parents=True, exist_ok=True)
            window.grabWindow().save(str(Path(shots) / f"{name}.png"))

    for page, name in enumerate(["overview", "gestures", "band"]):
        window.setProperty("currentPage", page)
        settle_and_shoot(f"page-{page}-{name}")
    window.setProperty("showingSetup", True)
    for step, name in enumerate(["pair", "swipe", "dial", "summary"]):
        window.setProperty("setupStep", step)
        settle_and_shoot(f"setup-{step}-{name}")
    # Unpaired: the pairing flow replaces the pages.
    window.setProperty("showingSetup", False)
    daemon._take_state({**daemon.state, "enrolled": False, "band": None, "metaUser": None})
    settle_and_shoot("pairing")
    for line in warnings:
        print(line, file=sys.stderr)
    print(f"checked: {len(warnings)} QML warning(s)")
    return 1 if warnings else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tray-only", action="store_true", help="start with the window hidden (login autostart)")
    parser.add_argument("--check", action="store_true", help="offscreen smoke test of every page; no daemon needed")
    parser.add_argument("--screenshots", metavar="DIR", help="with --check: save a PNG of each page and setup step")
    parser.add_argument("--socket", default=socket_path(), help="daemon socket (default: %(default)s)")
    args = parser.parse_args()
    if args.check:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    # Plasma's platform theme picks these anyway; being explicit keeps the window native elsewhere
    # (and makes --check render what you'd actually see).
    os.environ.setdefault("QT_QUICK_CONTROLS_STYLE", "org.kde.desktop")

    app = QApplication(sys.argv)
    if not QIcon.themeName() or QIcon.themeName() == "hicolor":
        QIcon.setThemeName("breeze")
    app.setApplicationName("Kinesis")
    app.setDesktopFileName("kinesis")
    app.setWindowIcon(QIcon(str(HERE / "icons" / "kinesis.svg")))
    app.setQuitOnLastWindowClosed(False)

    # One UI per session: a second launch just shows the running one's window.
    instance = f"kinesis-ui-{os.getuid()}"
    if not args.check:
        probe = QLocalSocket()
        probe.connectToServer(instance)
        if probe.waitForConnected(300):
            probe.write(b"show\n")
            probe.waitForBytesWritten(300)
            return 0
        QLocalServer.removeServer(instance)

    daemon = Daemon(args.socket, start_service=not args.check)
    engine = QQmlApplicationEngine()
    try:
        return run(args, app, daemon, engine, instance)
    finally:
        # Tear the QML down before the daemon object it binds to; otherwise, as Python frees
        # `daemon` first at exit, every binding re-runs against null and logs a TypeError.
        shiboken6.delete(engine)


def run(args, app: QApplication, daemon: Daemon, engine: QQmlApplicationEngine, instance: str) -> int:
    warnings: list = []
    engine.warnings.connect(lambda items: warnings.extend(w.toString() for w in items))
    engine.rootContext().setContextProperty("daemon", daemon)
    if args.check:
        return run_check(engine, app, daemon, warnings, args.screenshots)

    engine.load(QUrl.fromLocalFile(str(HERE / "qml" / "Main.qml")))
    if not engine.rootObjects():
        return 1
    window = engine.rootObjects()[0]

    def show_window() -> None:
        window.show()
        window.raise_()
        window.requestActivate()

    def toggle_window() -> None:
        if window.isVisible():
            window.hide()
        else:
            show_window()

    server = QLocalServer()
    server.listen(instance)
    server.newConnection.connect(lambda: (server.nextPendingConnection(), show_window()))
    daemon.showWindowRequested.connect(show_window)

    def quit_all() -> None:
        # Quitting stops the band service too, as on the Mac: no hidden controls without the icon.
        systemctl("stop", "kinesis.service")
        app.quit()

    tray = Tray(daemon, toggle_window, quit_all)  # noqa: F841 (kept alive for the app's lifetime)
    daemon.reconnect()
    if not args.tray_only:
        show_window()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
