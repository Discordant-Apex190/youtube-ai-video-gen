import { requireEnv } from "@/lib/env";

export type TtsVoiceConfig = {
  languageCode?: string;
  name?: string;
  ssmlGender?: "MALE" | "FEMALE" | "NEUTRAL";
};

export type TtsInput = {
  text: string;
};

export type TtsAudioConfig = {
  audioEncoding?: "MP3" | "OGG_OPUS" | "LINEAR16";
  speakingRate?: number;
  pitch?: number;
};

export type TtsResult = {
  audio: Uint8Array;
  mimeType: string;
};

const DEFAULT_VOICE: TtsVoiceConfig = {
  languageCode: "en-US",
  name: "en-US-Neural2-C",
  ssmlGender: "FEMALE",
};

const DEFAULT_AUDIO: TtsAudioConfig = {
  audioEncoding: "MP3",
  speakingRate: 1,
};

export async function synthesizeSpeech(params: {
  input: TtsInput;
  voice?: TtsVoiceConfig;
  audioConfig?: TtsAudioConfig;
}): Promise<TtsResult> {
  const apiKey = requireEnv("GOOGLE_TTS_API_KEY");

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: params.input,
        voice: { ...DEFAULT_VOICE, ...params.voice },
        audioConfig: { ...DEFAULT_AUDIO, ...params.audioConfig },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google TTS request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { audioContent?: string };
  if (!data.audioContent) {
    throw new Error("Google TTS did not return audioContent");
  }

  const buffer = Uint8Array.from(atob(data.audioContent), (char) => char.charCodeAt(0));
  return { audio: buffer, mimeType: "audio/mpeg" };
}
