import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "./env.js";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!env.smtp.host || !env.smtp.user || !env.smtp.pass) {
    throw new Error(
      "Envio de e-mail não configurado: defina SMTP_HOST, SMTP_USER e SMTP_PASS no .env",
    );
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    });
  }

  return transporter;
}

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const client = getTransporter();

  await client.sendMail({
    from: env.smtp.from,
    to,
    subject,
    html,
  });
}
