import { disconnectPrisma, prisma } from "./lib/prisma.js";

async function test() {
  try {
    const usuarios = await prisma.tb_usuario.findMany();

    console.log("Usuarios:", usuarios);
  } finally {
    await disconnectPrisma();
  }
}

void test();