import jwt from "jsonwebtoken";
const JWT_SECRET = process.env.JWT_SECRET;
export function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader)
        return res.status(401).json({ error: "Token não informado" });
    const token = authHeader.split(" ")[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.userId = payload.userId;
        next();
    }
    catch {
        return res.status(401).json({ error: "Token inválido" });
    }
}
