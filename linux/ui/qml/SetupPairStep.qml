// Setup step 1: pair the band (the full pairing flow), then pick the wrist it's on.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Item {
    id: step

    readonly property var st: daemon.state
    readonly property var ctl: st.controller || ({})
    readonly property bool paired: !!st.band && st.enrolled === true

    PairingView {
        anchors.fill: parent
        visible: !step.paired
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width, Kirigami.Units.gridUnit * 28)
        visible: step.paired
        spacing: Kirigami.Units.largeSpacing * 2

        Kirigami.Heading {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            level: 1
            text: "Your desktop, in good hands."
        }
        QQC2.Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            text: "Which wrist is your band on?"
        }
        RowLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: Kirigami.Units.largeSpacing
            Repeater {
                model: [{ id: "left", title: "Left wrist" }, { id: "right", title: "Right wrist" }]
                // Not checkable: a click only asks the band. The selection always shows the daemon's
                // pending or confirmed hand, so both can never look chosen at once.
                delegate: QQC2.Button {
                    required property var modelData
                    readonly property bool selected: (step.ctl.pendingHand || step.ctl.bandHand) === modelData.id
                    text: modelData.title
                    icon.name: selected ? "checkmark" : ""
                    highlighted: selected
                    enabled: step.st.canChangeHand === true
                    onClicked: if (!selected) daemon.selectHand(modelData.id)
                }
            }
        }
        QQC2.Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            opacity: 0.7
            text: step.ctl.pendingHand ? "Switching…"
                : step.ctl.handSettingError ? step.ctl.handSettingError
                : step.ctl.handConfirmed ? "Confirmed by your band."
                : "Waiting for your band to connect. Press its button if it doesn't."
        }
    }
}
