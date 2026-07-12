import { generateText } from "ai";

import { getModel } from "./model-provider";
import { getModelConfig } from "./server-env";

type AudioGenerationInput = Record<string, unknown>;
type AudioGenerationResult = { text?: unknown };
type AudioGenerator = (input: AudioGenerationInput) => Promise<AudioGenerationResult>;

export class AgentChatService {
  private readonly generateTextImpl: AudioGenerator;
  private readonly model: string;

  constructor(input?: {
    generateTextImpl?: AudioGenerator;
    model?: string;
  }) {
    this.generateTextImpl =
      input?.generateTextImpl ?? (generateText as unknown as AudioGenerator);
    this.model = input?.model ?? getModelConfig().modelId;
  }

  async transcribeAudio(audioBytes: Buffer, mimeType: string): Promise<string> {
    const response = await this.generateTextImpl({
      model: getModel(this.model),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: audioBytes,
              mimeType,
            },
            {
              type: "text",
              text: "把這段語音轉成文字。只輸出辨識到的文字內容，不加任何前綴或說明。如果聽不清楚，回傳空字串。",
            },
          ],
        },
      ],
      temperature: 0,
    });
    return String(response.text ?? "").trim();
  }
}
