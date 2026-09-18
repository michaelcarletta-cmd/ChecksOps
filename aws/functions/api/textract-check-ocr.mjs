/**
 * Textract descriptive OCR runner. No Azure calls. No persistence.
 */
import {
  TextractClient,
  DetectDocumentTextCommand,
  AnalyzeDocumentCommand,
} from '@aws-sdk/client-textract';

const textract = () => new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });

const extractLines = (blocks = []) => (blocks || [])
  .filter((b) => b && b.BlockType === 'LINE' && b.Text)
  .map((b) => b.Text);

export const runTextract = async (bytes, deps = {}) => {
  try {
    const send = deps.textractSend || ((cmd) => textract().send(cmd));
    const analyzed = await send(new AnalyzeDocumentCommand({
      Document: { Bytes: bytes },
      FeatureTypes: ['FORMS'],
    }));
    return {
      blocks: analyzed.Blocks || [],
      lines: extractLines(analyzed.Blocks || []),
      engine: 'aws_textract_analyze',
      error: null,
    };
  } catch (analyzeError) {
    try {
      const send = deps.textractSend || ((cmd) => textract().send(cmd));
      const detected = await send(new DetectDocumentTextCommand({
        Document: { Bytes: bytes },
      }));
      return {
        blocks: detected.Blocks || [],
        lines: extractLines(detected.Blocks || []),
        engine: 'aws_textract_detect',
        error: null,
      };
    } catch (detectError) {
      const message = String(detectError?.message || analyzeError?.message || detectError).slice(0, 240);
      return { blocks: [], lines: [], engine: 'aws_textract', error: message };
    }
  }
};
