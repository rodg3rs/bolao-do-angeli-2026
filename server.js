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

// Cadastro e Login (Mantidos conforme regras anteriores)
app.post('/cadastrar', async (req, res) => {
    const { id, nome, apelido, senha, time } = req.body;
    try {
        const vCheck = await db.execute({ sql: "SELECT * FROM dVoucher WHERE ID = ?", args: [id] });
        if (vCheck.rows.length === 0) return res.json({ success: false, message: "Voucher não encontrado!" });
        if (vCheck.rows[0].Apelido !== null) return res.json({ success: false, message: "Voucher já utilizado!" });

        await db.execute({
            sql: "INSERT INTO dLogin (ID, Nome, Apelido, Senha, Time) VALUES (?, ?, ?, ?, ?)",
            args: [id, nome, apelido, senha, time]
        });

        await db.execute({ sql: "UPDATE dVoucher SET Apelido = ? WHERE ID = ?", args: [apelido, id] });

        const jogos = await db.execute("SELECT * FROM dTabela");
        for (const jogo of jogos.rows) {
            await db.execute({
                sql: "INSERT INTO dApostas (ID, Apelido, Jogo, Sel1, Ap1, Sel2, Ap2, Data, Horario) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                args: [id, apelido, jogo.Jogo, jogo.Sel1, 0, jogo.Sel2, 0, jogo.Data, jogo.Horario]
            });
        }
        res.json({ success: true, message: "Cadastro realizado!" });
    } catch (e) { res.status(500).json({ success: false, message: "Erro no cadastro." }); }
});

app.post('/login', async (req, res) => {
    const { apelido, senha } = req.body;
    try {
        const result = await db.execute({
            sql: "SELECT * FROM dLogin WHERE Apelido = ? AND Senha = ?",
            args: [apelido, senha]
        });
        if (result.rows.length > 0) res.json({ success: true, user: result.rows[0] });
        else res.json({ success: false, message: "Credenciais incorretas." });
    } catch (e) { res.status(500).json({ success: false, message: "Erro no servidor." }); }
});

// --- NOVA LOGA: MEUS PALPITES ---

// Buscar apostas do usuário logado
app.get('/minhas-apostas/:apelido', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM dApostas WHERE Apelido = ? ORDER BY Data, Horario",
            args: [req.params.apelido]
        });
        res.json({ success: true, apostas: result.rows });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Salvar palpite individual com trava de 10 minutos
app.post('/salvar-palpite', async (req, res) => {
    const { apelido, jogo, ap1, ap2 } = req.body;
    try {
        // Busca info do jogo para validar horário
        const info = await db.execute({
            sql: "SELECT Data, Horario FROM dTabela WHERE Jogo = ?",
            args: [jogo]
        });

        if (info.rows.length > 0) {
            const dataJogo = info.rows[0].Data; // Formato esperado: YYYY-MM-DD
            const horaJogo = info.rows[0].Horario; // Formato esperado: HH:MM
            
            const agora = new Date();
            const limite = new Date(`${dataJogo}T${horaJogo}:00`);
            limite.setMinutes(limite.getMinutes() - 10);

            if (agora > limite) {
                return res.json({ success: false, message: "Tempo esgotado! Bloqueado 10min antes." });
            }

            await db.execute({
                sql: "UPDATE dApostas SET Ap1 = ?, Ap2 = ? WHERE Apelido = ? AND Jogo = ?",
                args: [ap1, ap2, apelido, jogo]
            });
            res.json({ success: true });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// Rota para buscar mensagens (e limpar as antigas)
app.get('/get-chat', async (req, res) => {
    try {
        // Limpa automaticamente mensagens com mais de 24 horas [Regra solicitada]
        await db.execute("DELETE FROM dChat WHERE DataHora < datetime('now', '-1 day')");

        // Busca as últimas 50 mensagens para não sobrecarregar a tela
        const result = await db.execute("SELECT Apelido, Mensagem FROM dChat ORDER BY ID ASC LIMIT 50");
        res.json({ success: true, mensagens: result.rows });
    } catch (e) {
        console.error("Erro no chat:", e);
        res.status(500).json({ success: false });
    }
});

// Rota para enviar nova mensagem
app.post('/enviar-msg', async (req, res) => {
    const { apelido, mensagem } = req.body;
    
    // Validação extra de segurança no servidor
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