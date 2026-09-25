// The Kinesis window: the band column on the left, Overview / Gestures / Band pages on the right,
// the pairing flow in place of the pages until a band is paired, and the first-run setup over all
// of it. `daemon` is the Python client for the kinesis daemon (see kinesis-ui.py).

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Kirigami.ApplicationWindow {
    id: root

    title: "Kinesis"
    width: Kirigami.Units.gridUnit * 56
    height: Kirigami.Units.gridUnit * 40
    minimumWidth: Kirigami.Units.gridUnit * 40
    minimumHeight: Kirigami.Units.gridUnit * 30
    visible: false

    property int currentPage: 0
    property int setupStep: 0
    // First run shows setup until it's finished or skipped; "Run quick setup again" reopens it.
    property bool showingSetup: daemon.link && daemon.config.setupDone === false

    readonly property var st: daemon.state
    readonly property var ctl: st.controller || ({})
    readonly property bool paired: !!st.band && st.enrolled === true

    /// The display title for an action id, from the daemon's catalog.
    function actionTitle(id) {
        const actions = daemon.catalog.actions || [];
        for (let i = 0; i < actions.length; i++) {
            if (actions[i].id === id) return id === "none" ? "No action" : actions[i].title;
        }
        return id;
    }

    /// Start pairing; the first time (no Meta session) explain the sign-in before opening Meta's page.
    function startPairing(forceLogin) {
        if (forceLogin || !st.metaUser) {
            signInIntro.forceLogin = forceLogin;
            signInIntro.open();
        } else {
            daemon.pairBand(false);
        }
    }

    function showFactoryReset() {
        factoryResetSheet.open();
    }

    function openSetup() {
        setupStep = 0;
        showingSetup = true;
    }

    function finishSetup(enableControls) {
        daemon.setConfig({ setupDone: true });
        if (ctl.live) daemon.setControls(enableControls);
        showingSetup = false;
    }

    // Closing the window keeps Kinesis in the system tray.
    onClosing: (close) => {
        close.accepted = false;
        root.hide();
    }

    // The Mac app's ⌘⇧P: do the band's next step (pair, connect, enable or pause controls).
    Shortcut {
        sequence: "Ctrl+Shift+P"
        enabled: daemon.nextStep.enabled
        onActivated: daemon.nextStep.id === "pair" ? root.startPairing(false) : daemon.doNextStep()
    }

    Connections {
        target: daemon
        function onRequestFailed(message) {
            root.showPassiveNotification(message, "long");
        }
    }

    SignInIntro { id: signInIntro }
    FactoryResetSheet { id: factoryResetSheet }

    pageStack.globalToolBar.style: Kirigami.ApplicationHeaderStyle.None
    pageStack.initialPage: Kirigami.Page {
        id: mainPage

        padding: 0
        titleDelegate: Item {}
        globalToolBarStyle: Kirigami.ApplicationHeaderStyle.None

        Loader {
            anchors.fill: parent
            sourceComponent: !daemon.link ? notRunning : root.showingSetup ? setup : main
        }
    }

    Component {
        id: notRunning
        Kirigami.PlaceholderMessage {
            anchors.centerIn: parent
            width: parent.width - Kirigami.Units.gridUnit * 4
            icon.name: "network-disconnect"
            text: "Kinesis isn't running"
            explanation: "The background service that talks to your band isn't answering."
            helpfulAction: Kirigami.Action {
                icon.name: "media-playback-start"
                text: "Start it"
                onTriggered: daemon.startService()
            }
        }
    }

    Component {
        id: setup
        SetupWizard {}
    }

    Component {
        id: main
        RowLayout {
            spacing: 0

            BandColumn {
                Layout.preferredWidth: Kirigami.Units.gridUnit * 16
                Layout.fillHeight: true
                Layout.margins: Kirigami.Units.largeSpacing * 2
            }

            Kirigami.Separator { Layout.fillHeight: true }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

                RowLayout {
                    Layout.fillWidth: true
                    Layout.margins: Kirigami.Units.largeSpacing
                    visible: root.paired

                    QQC2.TabBar {
                        id: tabs
                        currentIndex: root.currentPage
                        QQC2.TabButton { text: "Overview"; width: implicitWidth; onClicked: root.currentPage = 0 }
                        QQC2.TabButton { text: "Gestures"; width: implicitWidth; onClicked: root.currentPage = 1 }
                        QQC2.TabButton { text: "Band"; width: implicitWidth; onClicked: root.currentPage = 2 }
                    }
                    Item { Layout.fillWidth: true }
                    QQC2.ToolButton {
                        icon.name: "tools-wizard"
                        text: "Run quick setup again"
                        display: QQC2.AbstractButton.TextBesideIcon
                        onClicked: root.openSetup()
                    }
                }

                Kirigami.InlineMessage {
                    Layout.fillWidth: true
                    Layout.leftMargin: Kirigami.Units.largeSpacing
                    Layout.rightMargin: Kirigami.Units.largeSpacing
                    type: Kirigami.MessageType.Warning
                    visible: !!root.ctl.error && root.paired
                    text: root.ctl.error || ""
                }

                StackLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    visible: root.paired
                    currentIndex: root.currentPage

                    OverviewPage {}
                    GesturesPage {}
                    BandPage {}
                }

                PairingView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    visible: !root.paired
                }
            }
        }
    }
}
