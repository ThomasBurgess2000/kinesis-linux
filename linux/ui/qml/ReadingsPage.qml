// Readings (developer mode): live raw EMG alongside gestures, an eight-channel trace of the last
// second of sensor time, rates, and raw recording. Port of the Mac app's ReadingsPage.

import QtCore
import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Dialogs
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kirigamiaddons.formcard as FormCard

QQC2.ScrollView {
    id: readingsPage

    readonly property var ctl: daemon.state.controller || ({})
    readonly property var readings: daemon.state.readings || ({})
    readonly property bool live: ctl.live === true
    readonly property string status: {
        if (!live) return "Connect your band to start readings.";
        if (readings.pending) return "Waiting for the band to confirm…";
        if (readings.active) return "EMG on · gestures stay enabled.";
        return "Stream muscle signals alongside gestures, without reconnecting.";
    }

    FileDialog {
        id: saveDialog
        title: "Choose where to save the raw EMG capture"
        fileMode: FileDialog.SaveFile
        defaultSuffix: "jsonl"
        nameFilters: ["JSON lines (*.jsonl)", "All files (*)"]
        currentFolder: StandardPaths.writableLocation(StandardPaths.DocumentsLocation)
        onAccepted: daemon.startRecording(selectedFile.toString())
    }

    ColumnLayout {
        width: readingsPage.availableWidth
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: "A closer look."; level: 1; Layout.fillWidth: true }
            QQC2.Label { text: "Developer"; opacity: 0.6 }
        }

        FormCard.FormCard {
            FormCard.FormSwitchDelegate {
                text: "Live EMG"
                description: readingsPage.status
                checked: readingsPage.readings.wanted === true
                enabled: readingsPage.live && !readingsPage.readings.pending
                onToggled: daemon.setConfig({ rawEMG: checked })
            }
        }

        Kirigami.InlineMessage {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.largeSpacing
            type: Kirigami.MessageType.Warning
            visible: !!readingsPage.readings.error
            text: readingsPage.readings.error || ""
        }

        FormCard.FormHeader { title: "Eight channels" }
        FormCard.FormCard {
            FormCard.AbstractFormDelegate {
                background: null
                contentItem: ColumnLayout {
                    spacing: Kirigami.Units.smallSpacing

                    QQC2.Label {
                        Layout.alignment: Qt.AlignRight
                        opacity: 0.6
                        text: readingsPage.readings.config
                            ? readingsPage.readings.config.sampleRate + " Hz configured · " + readingsPage.readings.config.adcBits + "-bit"
                            : "Awaiting configuration"
                    }

                    EMGTrace {
                        id: trace
                        Layout.fillWidth: true
                        Layout.preferredHeight: Kirigami.Units.gridUnit * 16
                        active: readingsPage.readings.active === true && readingsPage.live

                        QQC2.Label {
                            anchors.centerIn: parent
                            visible: !!readingsPage.readings.issue || trace.empty
                            width: Math.min(parent.width - Kirigami.Units.gridUnit * 2, implicitWidth)
                            wrapMode: Text.Wrap
                            horizontalAlignment: Text.AlignHCenter
                            padding: Kirigami.Units.largeSpacing
                            text: readingsPage.readings.issue
                                || (trace.active ? "Waiting for muscle signals…" : "Turn on live EMG to see your signals.")
                            background: Rectangle { color: Kirigami.Theme.backgroundColor; opacity: 0.94; radius: Kirigami.Units.smallSpacing }
                        }
                    }

                    RowLayout {
                        QQC2.Label { text: "Auto scale " + trace.low + "–" + trace.high + " ADC"; opacity: 0.6; Layout.fillWidth: true }
                        QQC2.Label {
                            opacity: 0.6
                            text: (readingsPage.readings.missingBatches || 0) + " batch gaps · " + (trace.active ? "1 s of sensor time" : "paused")
                        }
                    }
                    QQC2.Label {
                        visible: (readingsPage.readings.invalidFrames || 0) > 0
                        color: Kirigami.Theme.neutralTextColor
                        text: readingsPage.readings.invalidFrames + " invalid batches excluded from the graph."
                    }
                }
            }
        }

        FormCard.FormCard {
            Layout.topMargin: Kirigami.Units.largeSpacing
            FormCard.FormTextDelegate {
                text: Math.round(readingsPage.readings.sampleRate || 0) + " samples / sec / channel"
                description: ((readingsPage.readings.byteRate || 0) / 1000).toFixed(1) + " kB/s payload rate"
            }
            FormCard.FormDelegateSeparator {}
            FormCard.FormButtonDelegate {
                readonly property var recording: readingsPage.readings.recording
                icon.name: recording ? "media-playback-stop" : "media-record"
                text: recording ? "Stop recording" : "Record…"
                description: recording
                    ? "Recording " + Number(recording.frames).toLocaleString(Qt.locale(), "f", 0) + " batches · "
                        + recording.path.split("/").pop()
                    : "Records the original sensor payloads as JSONL. Values are ADC counts, not calibrated voltage."
                enabled: !!recording || (readingsPage.readings.active === true && readingsPage.live)
                onClicked: recording ? daemon.stopRecording() : saveDialog.open()
            }
        }

        Item { Layout.preferredHeight: Kirigami.Units.gridUnit }
    }
}
