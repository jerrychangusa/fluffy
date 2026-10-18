import { createHash } from 'node:crypto';
import { readIntakeForm } from './form.mjs';
import { validEmailAddress } from '../../src/shared/configuration.mjs';

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reference = ({ content_base64, review_status, ...file }) => file;

// Local administrative intake backend. Each customer thread owns one case.
// Supplied measurements remain unverified; clinical interpretation is a human task.
export class CaseStore {
  constructor({
    state,
    customerEmail,
    customerAccess = 'allowlist',
    orderId,
    now = () => Date.now(),
  }) {
    if (!['allowlist', 'authenticated'].includes(customerAccess))
      throw new Error('invalid_customer_access');
    if (
      customerAccess !== 'authenticated' &&
      !validEmailAddress(customerEmail?.toLowerCase())
    )
      throw new Error('customer_email_required');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(orderId || ''))
      throw new Error('order_id_required');
    Object.assign(this, {
      state,
      customerEmail: customerEmail?.toLowerCase(),
      customerAccess,
      orderId,
      now,
    });
  }

  bind(event, conversation) {
    const email = event.email || conversation.latest_email;
    const customer = email?.from_email?.toLowerCase();
    if (
      !validEmailAddress(customer) ||
      (this.customerAccess !== 'authenticated' &&
        customer !== this.customerEmail)
    )
      throw new Error('case_customer_mismatch');
    const key = 'support/case/' + event.conversation_id;
    const existing = this.state.get(key);
    if (existing && existing.customer_email !== customer)
      throw new Error('case_customer_mismatch');
    if (!existing)
      this.state.put(key, {
        id: event.conversation_id,
        order_id: this.orderId,
        customer_email: customer,
        prescription: null,
        pd: null,
        form: null,
        notes: [],
        completion: null,
      });
    return key;
  }

  read(event, conversation) {
    const record = this.state.get(this.bind(event, conversation));
    const missing = [];
    if (!record.prescription) missing.push('prescription');
    if (!record.pd) missing.push('pd');
    const version = digest({
      prescription: record.prescription,
      pd: record.pd,
      form: record.form,
    });
    return {
      ...record,
      version,
      missing,
      status: record.completion
        ? 'intake_complete'
        : missing.length
          ? 'awaiting_information'
          : 'ready_for_review',
      clinical_validation: 'not_performed',
    };
  }

  async record(event, conversation, input) {
    this.read(event, conversation);
    if (event.kind !== 'customer')
      throw new Error('intake_requires_customer_email');
    const update = {};
    const fileAt = (index) => {
      const attachment = event.email.attachments?.[index];
      const bytes = Buffer.from(attachment?.content_base64 || '', 'base64');
      if (
        !attachment ||
        attachment.source_email_id !== event.email.id ||
        bytes.length !== attachment.size_bytes ||
        createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
      )
        throw new Error('unverified_attachment');
      return attachment;
    };
    if (input.prescription_attachment_index !== undefined) {
      const file = fileAt(input.prescription_attachment_index);
      if (
        !['image/png', 'image/jpeg', 'application/pdf'].includes(
          file.content_type,
        ) ||
        (await readIntakeForm(file))
      )
        throw new Error('prescription_attachment_required');
      update.prescription = {
        ...reference(file),
        review_status: 'received_unverified',
      };
    }
    if (input.form_attachment_index !== undefined) {
      const file = fileAt(input.form_attachment_index);
      const values = await readIntakeForm(file);
      if (!values) throw new Error('fillable_intake_form_required');
      if (values.order_reference && values.order_reference !== this.orderId)
        throw new Error('form_order_mismatch');
      update.form = reference(file);
      if (values.pd_text) {
        if (!/\d/.test(values.pd_text))
          throw new Error('pd_measurement_missing');
        update.pd = {
          supplied_text: values.pd_text,
          source_email_id: event.email.id,
          source: 'form.pd_text',
          review_status: 'received_unverified',
        };
      }
    }
    if (input.pd_text !== undefined) {
      if (
        !/\d/.test(input.pd_text) ||
        !event.email.body_text.includes(input.pd_text)
      )
        throw new Error('pd_must_quote_customer_message');
      update.pd = {
        supplied_text: input.pd_text,
        source_email_id: event.email.id,
        source: 'email.body_text',
        review_status: 'received_unverified',
      };
    }
    if (!Object.keys(update).length) throw new Error('intake_data_required');
    this.state.transaction(() => {
      const key = this.bind(event, conversation);
      const eventKey = 'support/intake/' + event.email.id;
      const previous = this.state.get(eventKey) || {};
      for (const [field, value] of Object.entries(update)) {
        if (
          previous[field] &&
          JSON.stringify(previous[field]) !== JSON.stringify(value)
        )
          throw new Error('intake_change_requires_new_email');
      }
      if (Object.keys(update).some((field) => !previous[field])) {
        const record = this.state.get(key);
        Object.assign(record, update, { completion: null });
        this.state.put(key, record);
        this.state.put(eventKey, { ...previous, ...update });
      }
    });
    return this.read(event, conversation);
  }

  evidence(event, conversation) {
    const record = this.read(event, conversation);
    return [record.prescription, record.form].filter(Boolean).map(reference);
  }

  receiveReceipt(event, conversation) {
    const key = this.bind(event, conversation);
    const record = this.state.get(key);
    if (
      event.receipt.protocol === 'question.receipt/1' &&
      event.receipt.status === 'answered'
    ) {
      if (
        !record.notes.some(
          (note) => note.request_id === event.receipt.request_id,
        )
      ) {
        record.notes.push({
          request_id: event.receipt.request_id,
          ...event.receipt.answer,
        });
        record.notes = record.notes.slice(-10);
      }
    }
    if (
      event.receipt.status === 'executed' &&
      conversation.pending?.type === 'support.complete'
    ) {
      if (
        conversation.pending.parameters.case_version !==
        this.read(event, conversation).version
      )
        throw new Error('approved_case_changed');
      record.completion = {
        request_id: event.receipt.request_id,
        action_hash: event.receipt.action_hash,
        at: this.now(),
      };
    }
    this.state.put(key, record);
  }
}
