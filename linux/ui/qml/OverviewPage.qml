// Overview: the last gesture and what it did, live, plus your current assignments.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

QQC2.ScrollView {
    id: overviewPage

    readonly property var ctl: daemon.state.controller || ({})
    property string lastGesture: ""
    property string lastAction: ""

    Connections {
        target: daemon
        function onGesture(gesture) {
            overviewPage.lastGesture = gesture.label;
            overviewPage.lastAction = gesture.action === "none" ? "" : gesture.actionTitle;
            flash.restart();
        }
    }

    ColumnLayout {
        width: overviewPage.availableWidth
        spacing: Kirigami.Units.largeSpacing

        Kirigami.AbstractCard {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing
            Layout.preferredHeight: Kirigami.Units.gridUnit * 9

            contentItem: ColumnLayout {
                id: live
                spacing: Kirigami.Units.smallSpacing

                Kirigami.Heading {
                    Layout.alignment: Qt.AlignHCenter
                    level: 1
                    text: overviewPage.lastGesture || "Waiting for a gesture"
                    opacity: overviewPage.lastGesture ? 1 : 0.5
                }
                QQC2.Label {
                    Layout.alignment: Qt.AlignHCenter
                    visible: overviewPage.lastGesture !== ""
                    text: (overviewPage.ctl.controlsEnabled ? "" : "Paused · ") + (overviewPage.lastAction ? "→ " + overviewPage.lastAction : "not assigned")
                    opacity: 0.8
                }
                QQC2.Label {
                    Layout.alignment: Qt.AlignHCenter
                    visible: overviewPage.lastGesture === ""
                    text: overviewPage.ctl.live ? "Swipe or tap with your thumb to see it here." : "Connect your band to see gestures here."
                    opacity: 0.6
                }

                SequentialAnimation {
                    id: flash
                    NumberAnimation { target: live; property: "scale"; to: 1.06; duration: 90 }
                    NumberAnimation { target: live; property: "scale"; to: 1.0; duration: 180; easing.type: Easing.OutQuad }
                }
            }
        }

        FormCard.FormHeader { title: "Your gestures" }
        GestureSummary {}

        QQC2.Label {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing * 2
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            opacity: 0.6
            text: "Close this window: Kinesis stays in your system tray."
        }
    }
}
