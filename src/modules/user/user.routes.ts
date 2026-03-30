import { Router } from "express";
import { UsersController } from "./user.controller.js";

export const usersRouter = Router();

usersRouter.post("/", UsersController.create);
usersRouter.get("/", UsersController.findAll);
usersRouter.get("/:id", UsersController.findById);
usersRouter.put("/:id", UsersController.update);
usersRouter.delete("/:id", UsersController.delete);