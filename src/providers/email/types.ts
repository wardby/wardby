/**
 * Email seam — outbound and inbound mail.
 *
 * Backs the sandbox `sendEmail` / `getInboundEmail` APIs.
 * Default adapter: SmtpEmailProvider.
 * Native adapter:  SesSnsS3EmailProvider (SES out; SNS/S3 inbound).
 */

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutboundEmail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Sender address; the provider's configured default is used if omitted. */
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export interface InboundEmail {
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments: EmailAttachment[];
  receivedAt: Date;
  /** True only if the provider verified DMARC (with SPF/DKIM alignment). */
  dmarcPass: boolean;
}

export interface EmailProvider {
  send(msg: OutboundEmail): Promise<{ messageId: string }>;
  /** Fetch messages routed to a mailbox/address key. */
  fetchInbound(mailbox: string, opts?: { since?: Date; limit?: number }): Promise<InboundEmail[]>;
}
