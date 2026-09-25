// After forgetting the band: it's still claimed to the Meta account until it's factory reset.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Kirigami.Dialog {
    id: dialog

    title: "Two quick things"
    preferredWidth: Kirigami.Units.gridUnit * 26
    standardButtons: Kirigami.Dialog.NoButton
    customFooterActions: [
        Kirigami.Action { text: "Done"; onTriggered: dialog.close() },
        Kirigami.Action { text: "Not now"; onTriggered: dialog.close() }
    ]

    ColumnLayout {
        spacing: Kirigami.Units.largeSpacing * 2

        QQC2.Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            text: "The band stays claimed to your Meta account. To hand it off or start fresh:"
        }

        ColumnLayout {
            spacing: Kirigami.Units.smallSpacing
            QQC2.Label { text: "1. Factory reset the band"; font.bold: true }
            QQC2.Button {
                flat: true
                icon.name: "help-contents"
                text: "How to factory reset"
                onClicked: Qt.openUrlExternally(daemon.factoryResetUrl)
            }
        }

        ColumnLayout {
            spacing: Kirigami.Units.smallSpacing
            QQC2.Label { text: "2. Forget it in Bluetooth settings"; font.bold: true }
            QQC2.Button {
                flat: true
                icon.name: "preferences-system-bluetooth"
                text: "Open Bluetooth settings"
                onClicked: daemon.openBluetoothSettings()
            }
        }
    }
}
