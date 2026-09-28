// Criando um novo tipo de Error, para podermos incluir itens como statusCode na hora de fazer um throw new Error.

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
