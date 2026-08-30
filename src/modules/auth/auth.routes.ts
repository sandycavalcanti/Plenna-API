import { Router } from "express";
import { AuthController } from "./auth.controller.js";

export const authRouter = Router();

authRouter.post("/register", AuthController.register);
authRouter.post("/login", AuthController.login);
authRouter.post("/forgot-password", AuthController.forgotPassword);
authRouter.post("/verify-reset-code", AuthController.verifyResetCode);
authRouter.post("/reset-password", AuthController.resetPassword);