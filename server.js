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

// --- CADASTRO ---
app.post('/cadastrar', async (req, res) => {
    const { id, nome, apelido, senha, time } = req.body; 

    try {
        // 1. Verifica se o CPF já foi usado
        const usuarioExistente = await db.execute({
            sql: "SELECT ID FROM dLogin WHERE ID = ?",
            args: [id]
        });

        if (usuarioExistente.rows.length > 0) {
            return res.json({ success: false, message: "Este CPF já possui um cadastro ativo." });
        }

        // 2. Insere o novo usuário na dLogin
        await db.execute({
            sql: "INSERT INTO dLogin (ID, Nome, Apelido, Senha, Time) VALUES (?, ?, ?, ?, ?)",
            args: [id, nome, apelido, senha, time]
        });

        // 3. Busca todos os jogos da dTabela para gerar as apostas iniciais
        const jogos = await db.execute("SELECT Jogo, Data, Horario FROM dTabela");

        // 4. Preenche a tabela dApostas
        // CORREÇÃO: Usando um loop for...of correto para garantir que todas as inserções terminem
        for (const jogo of jogos.rows) {
            await db.execute({
                sql: "INSERT INTO dApostas (ID_Usuario, Apelido, Jogo, Data, Horario, Ap1, Ap2) VALUES (?, ?, ?, ?, ?, 0, 0)",
                args: [id, apelido, jogo.Jogo, jogo.Data, jogo.Horario]
            });
        }

        res.json({ success: true, message: "Cadastro realizado e apostas geradas!" });
    } catch (e) {
        console.error("Erro no cadastro:", e);
        res.status(500).json({ success: false, message: "Erro ao processar cadastro no banco." });
    }
});

// --- LOGIN ---
app.post('/login', async (req, res) => {
    const { apelido, senha } = req.body;
    try {
        const result = await db.execute({
            sql: "SELECT * FROM dLogin WHERE Apelido = ? AND Senha = ?",
            args: [apelido, senha]
        });
        // CORREÇÃO: Certificando que o objeto 'user' contém o ID (CPF) para o frontend usar
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] }); 
        } else {
            res.json({ success: false, message: "Apelido ou senha incorretos." });
        }
    } catch (e) { 
        res.status(500).json({ success: false, message: "Erro no servidor." }); 
    }
});

// --- MEUS PALPITES ---

app.get('/minhas-apostas/:apelido', async (req, res) => {
    try {
        // CORREÇÃO: Mantendo a ordenação por Data e Horário conforme solicitado
        const result = await db.execute({
            sql: "SELECT * FROM dApostas WHERE Apelido = ? ORDER BY Data, Horario",
            args: [req.params.apelido]
        });
        res.json({ success: true, apostas: result.rows });
    } catch (e) { 
        res.status(500).json({ success: false }); 
    }
});

app.post('/salvar-palpite', async (req, res) => {
    const { apelido, jogo, ap1, ap2 } = req.body;
    try {
        const info = await db.execute({
            sql: "SELECT Data, Horario FROM dTabela WHERE Jogo = ?",
            args: [jogo]
        });

        if (info.rows.length > 0) {
            const dataJogo = info.rows[0].Data; 
            const horaJogo = info.rows[0].Horario; 
            
            const agora = new Date();
            // CORREÇÃO: Garantindo que o formato da data/hora seja aceito pelo construtor Date
            const limite = new Date(`${dataJogo}T${horaJogo}:00`);
            limite.setMinutes(limite.setMinutes() - 10);

            if (agora > limite) {
                return res.json({ success: false, message: "Tempo esgotado! Bloqueado 10min antes." });
            }

            // CORREÇÃO: O seu código usava colunas Ap1/Ap2, certifique-se que o banco bate com isso
            await db.execute({
                sql: "UPDATE dApostas SET Ap1 = ?, Ap2 = ? WHERE Apelido = ? AND Jogo = ?",
                args: [ap1, ap2, apelido, jogo]
            });
            res.json({ success: true });
        }
    } catch (e) { 
        console.error("Erro ao salvar palpite:", e);
        res.status(500).json({ success: false }); 
    }
});

// --- CHAT (24 Horas) ---

app.get('/get-chat', async (req, res) => {
    try {
        // Regra de 24h: Limpa mensagens antigas antes de buscar
        await db.execute("DELETE FROM dChat WHERE DataHora < datetime('now', '-1 day')");

        const result = await db.execute("SELECT Apelido, Mensagem FROM dChat ORDER BY ID ASC LIMIT 50");
        res.json({ success: true, mensagens: result.rows });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/enviar-msg', async (req, res) => {
    const { apelido, mensagem } = req.body;
    if(!apelido || !mensagem) return res.status(400).json({ success: false });

    try {
        await db.execute({
            sql: "INSERT INTO dChat (Apelido, Mensagem) VALUES (?, ?)",
            args: [apelido, mensagem]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));