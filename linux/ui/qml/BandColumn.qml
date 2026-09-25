// The always-visible band column: artwork, name, status, the next-step button, and readouts.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

ColumnLayout {
    id: column

    readonly property var st: daemon.state
    readonly property var ctl: st.controller || ({})
    readonly property bool paired: !!st.band && st.enrolled === true
    readonly property bool working: ctl.status === "connecting" || ctl.status === "reconnecting" || (st.pairing && st.pairing.active)
    readonly property string statusText: {
        if (!st.band) return "No band yet";
        if (st.pairing && st.pairing.active) return st.pairing.message;
        if (!st.enrolled) return "Setup incomplete";
        if (ctl.live && !ctl.controlsEnabled) return "Connected · controls paused";
        return ctl.phase || "";
    }
    readonly property string notice: {
        if (ctl.battery !== undefined && ctl.battery !== null && ctl.battery <= 15 && !ctl.charging) return "Low battery";
        if (column.working && !ctl.live) return "Press the band's button if it doesn't connect";
        return "";
    }

    spacing: Kirigami.Units.largeSpacing

    Image {
        Layout.alignment: Qt.AlignHCenter
        Layout.topMargin: Kirigami.Units.gridUnit
        source: Qt.resolvedUrl("../icons/" + (column.ctl.live ? "kinesis.svg" : "kinesis-inactive.svg"))
        sourceSize.width: Kirigami.Units.gridUnit * 6
        sourceSize.height: Kirigami.Units.gridUnit * 6
    }

    Kirigami.Heading {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        level: 2
        text: column.st.band ? column.st.band.name : "Neural Band"
        elide: Text.ElideRight
    }

    RowLayout {
        Layout.alignment: Qt.AlignHCenter
        spacing: Kirigami.Units.smallSpacing

        Rectangle {
            id: dot
            implicitWidth: Kirigami.Units.smallSpacing * 2
            implicitHeight: implicitWidth
            radius: width / 2
            color: column.ctl.live ? Kirigami.Theme.positiveTextColor
                 : column.working ? Kirigami.Theme.neutralTextColor : Kirigami.Theme.disabledTextColor
            SequentialAnimation on opacity {
                running: column.working
                loops: Animation.Infinite
                alwaysRunToEnd: true
                NumberAnimation { to: 0.3; duration: 600 }
                NumberAnimation { to: 1; duration: 600 }
            }
        }
        QQC2.Label {
            text: column.statusText
            wrapMode: Text.Wrap
            Layout.maximumWidth: column.width - dot.width - Kirigami.Units.largeSpacing
        }
    }

    Kirigami.Chip {
        Layout.alignment: Qt.AlignHCenter
        visible: column.notice !== ""
        text: column.notice
        closable: false
        checkable: false
        icon.name: "dialog-information"
    }

    QQC2.Button {
        Layout.alignment: Qt.AlignHCenter
        Layout.topMargin: Kirigami.Units.largeSpacing
        visible: daemon.nextStep.id !== "none"
        enabled: daemon.nextStep.enabled
        highlighted: true
        text: daemon.nextStep.id === "pair" && column.st.pairing && column.st.pairing.error ? "Try again" : daemon.nextStep.title
        onClicked: daemon.nextStep.id === "pair" ? applicationWindow().startPairing(false) : daemon.doNextStep()
    }

    QQC2.Button {
        Layout.alignment: Qt.AlignHCenter
        flat: true
        visible: column.st.wantsConnection === true || (column.st.pairing && column.st.pairing.active)
        text: column.st.pairing && column.st.pairing.active ? "Cancel" : "Disconnect"
        onClicked: column.st.pairing && column.st.pairing.active ? daemon.cancelPairing() : daemon.disconnectBand()
    }

    Item { Layout.fillHeight: true }

    Kirigami.Separator { Layout.fillWidth: true }

    GridLayout {
        Layout.fillWidth: true
        columns: 2
        columnSpacing: Kirigami.Units.largeSpacing

        QQC2.Label { text: "Battery"; opacity: 0.7 }
        QQC2.Label {
            Layout.alignment: Qt.AlignRight
            text: column.ctl.battery === undefined || column.ctl.battery === null ? "—"
                : column.ctl.battery + "%" + (column.ctl.charging ? " · charging" : "")
        }
        QQC2.Label { text: "Gestures"; opacity: 0.7 }
        QQC2.Label { Layout.alignment: Qt.AlignRight; text: String(column.ctl.gestureCount || 0) }
    }
}
