#!/usr/bin/env swift

// apple_stt.swift — Native macOS Speech-to-Text using SFSpeechRecognizer
//
// Usage: apple_stt --audio <path.wav> [--language ko-KR]
// Output: JSON { "text": "...", "language": "ko-KR" }
//
// Requires macOS 10.15+ and Speech Recognition permission.
// Grant permission: System Settings → Privacy & Security → Speech Recognition

import Foundation
import Speech

// MARK: - Argument Parsing

var audioPath: String?
var languageCode = "ko-KR"

var args = CommandLine.arguments.dropFirst()
while let arg = args.first {
    args = args.dropFirst()
    switch arg {
    case "--audio":
        audioPath = args.first
        args = args.dropFirst()
    case "--language":
        if let lang = args.first {
            let langMap: [String: String] = [
                "ko": "ko-KR", "en": "en-US", "ja": "ja-JP",
                "zh": "zh-CN", "es": "es-ES", "fr": "fr-FR",
                "de": "de-DE", "it": "it-IT", "pt": "pt-BR",
            ]
            languageCode = langMap[lang] ?? lang
            args = args.dropFirst()
        }
    default:
        break
    }
}

guard let audioFile = audioPath else {
    let json: [String: Any] = ["error": "Usage: apple_stt --audio <path.wav> [--language ko-KR]", "text": ""]
    if let data = try? JSONSerialization.data(withJSONObject: json),
       let str = String(data: data, encoding: .utf8) { print(str) }
    exit(1)
}

let fileURL = URL(fileURLWithPath: audioFile)
guard FileManager.default.fileExists(atPath: audioFile) else {
    let json: [String: Any] = ["error": "Audio file not found: \(audioFile)", "text": ""]
    if let data = try? JSONSerialization.data(withJSONObject: json),
       let str = String(data: data, encoding: .utf8) { print(str) }
    exit(1)
}

func log(_ msg: String) {
    FileHandle.standardError.write(Data("[apple_stt] \(msg)\n".utf8))
}

// MARK: - Speech Recognition (RunLoop-based to avoid deadlock)

var finished = false
var resultText = ""
var resultError: String?
let startTime = Date()
let timeoutSeconds: TimeInterval = 30

log("Starting recognition for \(audioFile)")

SFSpeechRecognizer.requestAuthorization { status in
    log("Authorization status: \(status.rawValue)")
    
    guard status == .authorized else {
        resultError = "Speech recognition not authorized (status=\(status.rawValue)). Grant in System Settings → Privacy & Security → Speech Recognition."
        finished = true
        return
    }

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: languageCode)) else {
        resultError = "SFSpeechRecognizer not available for locale: \(languageCode)"
        finished = true
        return
    }

    guard recognizer.isAvailable else {
        resultError = "SFSpeechRecognizer not available (offline model may not be downloaded)"
        finished = true
        return
    }

    let request = SFSpeechURLRecognitionRequest(url: fileURL)

    // Don't force on-device — allow server fallback
    if #available(macOS 13.0, *) {
        let onDevice = recognizer.supportsOnDeviceRecognition
        request.requiresOnDeviceRecognition = false
        log("onDevice=\(onDevice), locale=\(languageCode), available=\(recognizer.isAvailable)")
    }

    recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            let nsError = error as NSError
            log("error: domain=\(nsError.domain) code=\(nsError.code) \(error.localizedDescription)")
            if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1110 {
                resultText = ""
                finished = true
                return
            }
            resultError = error.localizedDescription
            finished = true
            return
        }

        guard let result = result else { return }
        log("partial: \(result.bestTranscription.formattedString)")

        if result.isFinal {
            resultText = result.bestTranscription.formattedString
            log("final: \(resultText)")
            finished = true
        }
    }
}

// MARK: - RunLoop (avoids semaphore deadlock on main thread)

while !finished {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
    if Date().timeIntervalSince(startTime) > timeoutSeconds {
        resultError = "Speech recognition timed out after \(Int(timeoutSeconds))s"
        break
    }
}

// MARK: - Output JSON

var output: [String: Any] = [:]
if let err = resultError {
    output["error"] = err
    output["text"] = ""
} else {
    output["text"] = resultText
}
output["language"] = languageCode

if let data = try? JSONSerialization.data(withJSONObject: output),
   let str = String(data: data, encoding: .utf8) {
    print(str)
}

exit(resultError != nil ? 1 : 0)
