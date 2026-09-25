// Before opening Meta's page: why the sign-in is needed, what's kept, and how to undo it.

import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Kirigami.Dialog {
    id: dialog

    property bool forceLogin: false

    title: "Sign in with Meta"
    preferredWidth: Kirigami.Units.gridUnit * 26
    standardButtons: Kirigami.Dialog.NoButton
    customFooterActions: [
        Kirigami.Action {
            text: "Continue to Meta"
            icon.name: "go-next"
            onTriggered: {
                dialog.close();
                daemon.pairBand(dialog.forceLogin);
            }
        },
        Kirigami.Action { text: "Not now"; onTriggered: dialog.close() }
    ]

    ColumnLayout {
        spacing: Kirigami.Units.largeSpacing

        QQC2.Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            text: "Your band is tied to your Meta account, so Kinesis needs it once to claim the band for this computer."
        }

        Repeater {
            model: [
                { icon: "internet-web-browser", title: "You sign in on Meta's page",
                  detail: "Your browser opens Meta's own sign-in. Kinesis gets a session token, never your password." },
                { icon: "document-encrypt", title: "The token stays on this computer",
                  detail: "It's kept in your home folder. Forgetting the band removes it." },
                { icon: "preferences-system-bluetooth", title: "Your band stays on your account",
                  detail: "A factory reset of the band undoes the claim." },
            ]
            delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                spacing: Kirigami.Units.largeSpacing
                Kirigami.Icon {
                    Layout.alignment: Qt.AlignTop
                    implicitWidth: Kirigami.Units.iconSizes.medium
                    implicitHeight: Kirigami.Units.iconSizes.medium
                    source: modelData.icon
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 0
                    QQC2.Label { text: modelData.title; font.bold: true }
                    QQC2.Label { Layout.fillWidth: true; wrapMode: Text.Wrap; text: modelData.detail; opacity: 0.8 }
                }
            }
        }
    }
}
