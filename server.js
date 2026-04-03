require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Rota de Cadastro (Necessária para o index.html)
app.post('/cadastrar', async (req, res) => {
    const { id, nome, apelido, senha, time } = req.body;
    try {
        // Verifica se o voucher existe e não foi usado
        const vCheck = await db.execute({
            sql: "SELECT * FROM dVouchers WHERE ID = ? AND Usado = 0",
            args: [id]
        });

        if (vCheck.rows.length === 0) {
            return res.json({ success: false, message: "Voucher inválido ou já utilizado!" });
        }

        // Insere o novo usuário
        await db.execute({
            sql: "INSERT INTO dLogin (ID, Nome, Apelido, Senha, Time) VALUES (?, ?, ?, ?, ?)",
            args: [id, nome, apelido, senha, time]
        });

        // Marca o voucher como usado
        await db.execute({
            sql: "UPDATE dVouchers SET Usado = 1 WHERE ID = ?",
            args: [id]
        });

        res.json({ success: true, message: "Cadastro realizado com sucesso!" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Erro ao cadastrar (Apelido já existe?)" });
    }
});

// Rota de Login Corrigida
app.post('/login', async (req, res) => {
    const { apelido, senha } = req.body;
    try {
        const result = await db.execute({
            sql: "SELECT * FROM dLogin WHERE Apelido = ? AND Senha = ?",
            args: [apelido, senha]
        });

        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, message: "Apelido ou Senha incorretos." });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Erro no servidor." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));