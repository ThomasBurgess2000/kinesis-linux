// Pairing: find → sign in → claim → ready, driven by the daemon's pairing state. Used in place of
// the pages until a band is paired, and as the first setup step.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Item {
    id: view

    readonly property var st: daemon.state
    readonly property var pairing: st.pairing || ({})
    readonly property bool paired: !!st.band && st.enrolled === true
    readonly property var steps: [
        { id: "find", title: "Find" }, { id: "signIn", title: "Sign in" }, { id: "claim", title: "Claim" }, { id: "ready", title: "Ready" },
    ]
    readonly property string current: pairing.active ? pairing.step : pairing.error ? pairing.failedStep : paired ? "ready" : ""
    readonly property int currentIndex: steps.findIndex((s) => s.id === current)

    // The band's ceremony stages, as the Mac app words them.
    readonly property var claimTicks: ["Reading the band.", "Checking with Meta.", "Confirming with the band.", "Swapping keys."]
    readonly property int claimTick: {
        switch (pairing.message) {
        case "reading the band identity": return 1;
        case "claiming the band": return 2;
        case "confirming ownership": return 3;
        case "establishing trust": return 4;
        default: return pairing.step === "ready" ? 4 : 0;
        }
    }

    readonly property string headline: {
        if (pairing.error) {
            switch (pairing.failedStep) {
            case "signIn": return "Couldn't sign in";
            case "claim": return "Couldn't claim your band";
            case "ready": return "Couldn't reconnect";
            default: return "Couldn't find your band";
            }
        }
        if (pairing.active) {
            switch (pairing.step) {
            case "signIn": return "Sign in with Meta";
            case "claim": return "Claiming your band";
            case "ready": return "Almost done";
            default: return "Looking for your band";
            }
        }
        return paired ? "Your band is paired" : "Pair your band";
    }

    readonly property string detail: {
        if (pairing.error) return pairing.error;
        if (pairing.active) return pairing.step === "claim" && claimTick > 0 ? "Keep the band on your wrist." : pairing.message;
        if (paired) return "You're all set.";
        return "Kinesis claims your band for this computer through your Meta account. Hold the band's button for 3 seconds, until its light flashes, then pair.";
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width - Kirigami.Units.gridUnit * 4, Kirigami.Units.gridUnit * 30)
        spacing: Kirigami.Units.largeSpacing * 2

        RowLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: Kirigami.Units.largeSpacing
            Repeater {
                model: view.steps
                delegate: RowLayout {
                    required property var modelData
                    required property int index
                    spacing: Kirigami.Units.smallSpacing
                    Rectangle {
                        implicitWidth: Kirigami.Units.gridUnit
                        implicitHeight: implicitWidth
                        radius: width / 2
                        color: index < view.currentIndex || (index === view.currentIndex && view.paired && !view.pairing.active)
                            ? Kirigami.Theme.positiveTextColor
                            : index === view.currentIndex
                                ? (view.pairing.error ? Kirigami.Theme.negativeTextColor : Kirigami.Theme.highlightColor)
                                : Kirigami.Theme.disabledTextColor
                    }
                    QQC2.Label {
                        text: modelData.title
                        font.bold: index === view.currentIndex
                        opacity: index <= view.currentIndex ? 1 : 0.6
                    }
                }
            }
        }

        Kirigami.Heading {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            level: 1
            text: view.headline
            wrapMode: Text.Wrap
        }

        QQC2.Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            text: view.detail
        }

        ColumnLayout {
            Layout.alignment: Qt.AlignHCenter
            visible: view.current === "claim" || (view.current === "ready" && view.pairing.active)
            Repeater {
                model: view.claimTicks
                delegate: RowLayout {
                    required property string modelData
                    required property int index
                    Kirigami.Icon {
                        implicitWidth: Kirigami.Units.iconSizes.small
                        implicitHeight: Kirigami.Units.iconSizes.small
                        source: index < view.claimTick ? "emblem-ok-symbolic" : "content-loading-symbolic"
                        opacity: index < view.claimTick ? 1 : 0.4
                    }
                    QQC2.Label { text: modelData; opacity: index < view.claimTick ? 1 : 0.5 }
                }
            }
        }

        QQC2.BusyIndicator {
            Layout.alignment: Qt.AlignHCenter
            visible: view.pairing.active === true && view.current !== "claim"
            running: visible
        }

        RowLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: Kirigami.Units.largeSpacing

            QQC2.Button {
                visible: !view.paired || !!view.pairing.error
                enabled: !view.pairing.active
                highlighted: true
                text: view.pairing.active ? "Pairing…" : view.pairing.error ? "Try again" : "Pair band"
                onClicked: applicationWindow().startPairing(false)
            }
            QQC2.Button {
                visible: view.pairing.active === true
                text: "Cancel"
                onClicked: daemon.cancelPairing()
            }
            QQC2.Button {
                visible: view.pairing.active === true && view.pairing.step === "signIn" && !!view.pairing.url
                flat: true
                icon.name: "internet-web-browser"
                text: "Open the sign-in page again"
                onClicked: Qt.openUrlExternally(view.pairing.url)
            }
        }

        RowLayout {
            Layout.alignment: Qt.AlignHCenter
            visible: !!view.pairing.error
            spacing: Kirigami.Units.largeSpacing
            QQC2.Button {
                visible: view.pairing.wrongAccount === true
                flat: true
                text: "Sign in with another account"
                onClicked: applicationWindow().startPairing(true)
            }
            QQC2.Button {
                visible: view.pairing.failedStep === "find" || view.pairing.wrongAccount === true
                flat: true
                icon.name: "help-contents"
                text: "How to factory reset"
                onClicked: Qt.openUrlExternally(daemon.factoryResetUrl)
            }
            QQC2.Button {
                visible: view.pairing.failedStep === "find" || view.pairing.failedStep === "ready"
                flat: true
                icon.name: "preferences-system-bluetooth"
                text: "Open Bluetooth settings"
                onClicked: daemon.openBluetoothSettings()
            }
        }
    }
}
