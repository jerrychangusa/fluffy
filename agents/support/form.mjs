import { PDFDocument } from 'pdf-lib';

// We parse our fillable form, not arbitrary medical documents or scanned PDFs.
export async function readIntakeForm(attachment) {
  if (attachment?.content_type !== 'application/pdf') return null;
  try {
    const document = await PDFDocument.load(
      Buffer.from(attachment.content_base64, 'base64'),
      { updateMetadata: false },
    );
    if (document.isEncrypted || document.getSubject() !== 'intake-form/1')
      return null;
    const form = document.getForm();
    const values = {};
    for (const name of [
      'order_reference',
      'customer_name',
      'pd_text',
      'completed_date',
    ]) {
      values[name] = (form.getTextField(name).getText() || '')
        .trim()
        .slice(0, 80);
    }
    return values;
  } catch {
    return null;
  }
}
