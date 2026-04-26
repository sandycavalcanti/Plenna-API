import { Router } from "express";
import { UsersController } from "./user.controller.js";
import { authMiddleware } from "../auth/auth.middleware.js";

export const usersRouter = Router();

usersRouter.post("/", UsersController.create);
usersRouter.get("/", UsersController.findAll);
usersRouter.get("/id/:id", UsersController.findById);
usersRouter.get("/email/:email", UsersController.findByEmail);
usersRouter.put("/id/:id", UsersController.update);
usersRouter.delete("/id/:id", UsersController.delete);
usersRouter.get("/user", authMiddleware, UsersController.findUserByToken);