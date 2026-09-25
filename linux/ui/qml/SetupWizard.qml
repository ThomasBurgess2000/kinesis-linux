// First-run setup, over the whole window: pair, try a swipe, try pinch + turn, then a summary.
// It shows until finished or skipped (config.setupDone), and again from "Run quick setup again".

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

ColumnLayout {
    id: wizard

    readonly property var win: applicationWindow()
    readonly property int step: win.setupStep
    readonly property var st: daemon.state
    readonly property var ctl: st.controller || ({})
    readonly property bool paired: !!st.band && st.enrolled === true
    readonly property var titles: ["Pair", "Swipe", "Pinch + turn", "Done"]

    function go(next) {
        win.setupStep = next;
    }

    // Leave setup without finishing: controls come back on, and setup won't reopen by itself.
    function setUpLater() {
        if (ctl.live) daemon.setControls(true);
        daemon.setConfig({ setupDone: true });
        win.showingSetup = false;
    }

    // Practising the dial mustn't change your volume: controls pause for that step.
    onStepChanged: if (step === 2 && ctl.live && ctl.controlsEnabled) daemon.setControls(false)

    spacing: 0

    RowLayout {
        Layout.alignment: Qt.AlignHCenter
        Layout.topMargin: Kirigami.Units.gridUnit
        spacing: Kirigami.Units.gridUnit
        Repeater {
            model: wizard.titles
            delegate: RowLayout {
                required property string modelData
                required property int index
                spacing: Kirigami.Units.smallSpacing
                Rectangle {
                    implicitWidth: Kirigami.Units.largeSpacing * 2
                    implicitHeight: implicitWidth
                    radius: width / 2
                    color: index < wizard.step ? Kirigami.Theme.positiveTextColor
                         : index === wizard.step ? Kirigami.Theme.highlightColor : Kirigami.Theme.disabledTextColor
                }
                QQC2.Label { text: modelData; font.bold: index === wizard.step; opacity: index <= wizard.step ? 1 : 0.6 }
            }
        }
    }

    StackLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.margins: Kirigami.Units.gridUnit
        currentIndex: wizard.step

        SetupPairStep {}
        SetupSwipeStep {}
        SetupDialStep {}
        SetupSummaryStep {}
    }

    Kirigami.Separator { Layout.fillWidth: true }

    RowLayout {
        Layout.fillWidth: true
        Layout.margins: Kirigami.Units.largeSpacing
        spacing: Kirigami.Units.largeSpacing

        QQC2.Button { flat: true; text: "Set up later"; onClicked: wizard.setUpLater() }
        QQC2.Button { flat: true; text: "Back"; visible: wizard.step > 0; onClicked: wizard.go(wizard.step - 1) }
        Item { Layout.fillWidth: true }
        QQC2.Button {
            flat: true
            visible: wizard.step === 1 || wizard.step === 2
            text: "Try it later"
            onClicked: wizard.go(wizard.step + 1)
        }
        QQC2.Button {
            flat: true
            visible: wizard.step === 3
            text: "Finish with controls paused"
            onClicked: wizard.win.finishSetup(false)
        }
        QQC2.Button {
            highlighted: true
            text: wizard.step === 3 ? "Let's go" : "Continue"
            enabled: wizard.step !== 0 || wizard.paired
            onClicked: wizard.step === 3 ? wizard.win.finishSetup(true) : wizard.go(wizard.step + 1)
        }
    }
}
