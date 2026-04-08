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

// CORREÇÃO NO CADASTRO
app.post('/cadastrar', async (req, res) => {
    const { id, nome, apelido, senha, time } = req.body; 

    try {
        const usuarioExistente = await db.execute({
            sql: "SELECT ID FROM dLogin WHERE ID = ?",
            args: [id]
        });

        if (usuarioExistente.rows.length > 0) {
            return res.json({ success: false, message: "CPF já cadastrado." });
        }

        await db.execute({
            sql: "INSERT INTO dLogin (ID, Nome, Apelido, Senha, Time) VALUES (?, ?, ?, ?, ?)",
            args: [id, nome, apelido, senha, time]
        });

	// 1. Busca jogos completos da dTabela
        const jogos = await db.execute("SELECT Jogo, Sel1, Sel2, Data, Horario FROM dTabela");

        // 2. Loop para carregar a tabela dApostas com todas as informações
        for (const jogo of jogos.rows) {
            await db.execute({
                sql: "INSERT INTO dApostas (ID, Apelido, Jogo, Sel1, Sel2, Data, Horario, Ap1, Ap2) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)",
                args: [id, apelido, jogo.Jogo, jogo.Sel1, jogo.Sel2, jogo.Data, jogo.Horario]
            });
        }

        res.json({ success: true, message: "Cadastro e apostas criadas!" });
    } catch (e) {
        console.error("Erro no cadastro:", e);
        res.status(500).json({ success: false, message: "Erro ao processar base de dados." });
    }
});

// CORREÇÃO NO LOGIN
app.post('/login', async (req, res) => {
    const { apelido, senha } = req.body;
    try {
        const result = await db.execute({
            sql: "SELECT * FROM dLogin WHERE Apelido = ? AND Senha = ?",
            args: [apelido, senha]
        });
        
        if (result.rows.length > 0) {
            // Garante que o ID (CPF) está a ser enviado para o frontend
            res.json({ success: true, user: result.rows[0] }); 
        } else {
            res.json({ success: false, message: "Credenciais incorretas." });
        }
    } catch (e) { res.status(500).json({ success: false }); }
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

// --- 0. ROTA ADMIN: BUSCAR LISTA DE JOGOS E RESULTADOS ---
app.get('/api/admin/jogos', async (req, res) => {
    try {
        // Traz todos os jogos da dTabela e junta com dResult para mostrar os que já têm placar
        const sql = `
            SELECT t.Jogo, t.Data, t.Horario, t.Sel1, t.Sel2, r.Res1, r.Res2
            FROM dTabela t
            LEFT JOIN dResult r ON t.Jogo = r.Jogo
            ORDER BY t.Data, t.Horario
        `;
        const result = await db.execute(sql);
        res.json({ success: true, jogos: result.rows });
    } catch (e) {
        console.error("Erro ao buscar jogos admin:", e);
        res.status(500).json({ success: false });
    }
});

// --- 1. ROTA ADMIN: ATUALIZAR RESULTADO E CALCULAR PONTOS ---
app.post('/api/admin/atualizar_resultado', async (req, res) => {
    const { jogo, res1, res2 } = req.body;
    const r1 = parseInt(res1);
    const r2 = parseInt(res2);

    try {
        // 1. Salva o resultado oficial na dResult
        await db.execute({
            sql: "INSERT INTO dResult (Jogo, Res1, Res2) VALUES (?, ?, ?) ON CONFLICT(Jogo) DO UPDATE SET Res1=excluded.Res1, Res2=excluded.Res2",
            args: [jogo, r1, r2]
        });

        // 2. A MÁGICA DO CÁLCULO: Atualiza dApostas e distribui os pontos de uma vez só!
        const sqlCalculo = `
            UPDATE dApostas 
            SET Res1 = ?, Res2 = ?, 
                Pontos = CASE 
                    WHEN Ap1 = ? AND Ap2 = ? THEN 3 
                    WHEN (Ap1 > Ap2 AND ? > ?) OR (Ap1 < Ap2 AND ? < ?) OR (Ap1 = Ap2 AND ? = ?) THEN 2 
                    ELSE 0 
                END
            WHERE Jogo = ?
        `;
        // Os parâmetros seguem a ordem exata das interrogações acima
        await db.execute({
            sql: sqlCalculo,
            args: [r1, r2, r1, r2, r1, r2, r1, r2, r1, r2, jogo]
        });

        res.json({ success: true, message: "Resultado salvo e pontos calculados com sucesso!" });
    } catch (e) {
        console.error("Erro ao calcular pontos:", e);
        res.status(500).json({ success: false });
    }
});

// --- 2. ROTA PÚBLICA DO RANKING (Pode ser acessada sem estar logado) ---
app.get('/api/ranking', async (req, res) => {
    try {
        // Soma os pontos de todos os jogos para cada usuário
        const result = await db.execute(`
            SELECT Apelido, SUM(Pontos) as Total 
            FROM dApostas 
            GROUP BY Apelido 
            ORDER BY Total DESC, Apelido ASC
        `);
        res.json({ success: true, ranking: result.rows });
    } catch (e) {
        console.error("Erro ao buscar ranking:", e);
        res.status(500).json({ success: false });
    }
});

app.post('/api/ping', async (req, res) => {
    const { apelido } = req.body;
    try {
        await db.execute({
            sql: "UPDATE dLogin SET InOut = datetime('now', 'localtime') WHERE LOWER(Apelido) = LOWER(?)",
            args: [apelido]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));