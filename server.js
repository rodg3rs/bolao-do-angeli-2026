require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Rota de Cadastro com as novas regras de negócio
app.post('/cadastrar', async (req, res) => {
    const { id, nome, apelido, senha, time } = req.body;
    
    try {
        // 1. Verifica se o Voucher existe e se o Apelido ainda é NULL
        const vCheck = await db.execute({
            sql: "SELECT * FROM dVouchers WHERE ID = ?",
            args: [id]
        });

        if (vCheck.rows.length === 0) {
            return res.json({ success: false, message: "ID (Voucher) não encontrado!" });
        }

        if (vCheck.rows[0].Apelido !== null) {
            return res.json({ success: false, message: "Este Voucher já foi utilizado por outro usuário!" });
        }

        // 2. Registra o usuário na tabela dLogin
        await db.execute({
            sql: "INSERT INTO dLogin (ID, Nome, Apelido, Senha, Time) VALUES (?, ?, ?, ?, ?)",
            args: [id, nome, apelido, senha, time]
        });

        // 3. Atualiza o Apelido na tabela dVouchers para o ID correspondente
        await db.execute({
            sql: "UPDATE dVouchers SET Apelido = ? WHERE ID = ?",
            args: [apelido, id]
        });

        // 4. Preenche a tabela dApostas com os registros de dTabela + ID e Apelido do novo usuário
        // Assume-se que dApostas tem as colunas: ID, Apelido, Jogo, Sel1, Ap1, Sel2... conforme sua estrutura
        const jogos = await db.execute("SELECT * FROM dTabela");
        
        for (const jogo of jogos.rows) {
            await db.execute({
                sql: `INSERT INTO dApostas (ID, Apelido, Jogo, Sel1, Ap1, Sel2, Ap2) 
                      VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: [id, apelido, jogo.Jogo, jogo.Sel1, 0, jogo.Sel2, 0]
            });
        }

        res.json({ success: true, message: "Cadastro e Tabela de Apostas criados com sucesso!" });

    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Erro ao processar cadastro. O apelido já pode estar em uso." });
    }
});

// Rota de Login
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
        res.status(500).json({ success: false, message: "Erro no servidor." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));