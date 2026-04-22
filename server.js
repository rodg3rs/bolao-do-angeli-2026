require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const app = express();
const nodemailer = require('nodemailer');

app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// --- CADASTRO ---
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

        const jogos = await db.execute("SELECT Jogo, Sel1, Sel2, Data, Horario FROM dTabela");

        for (const jogo of jogos.rows) {
            await db.execute({
                sql: "INSERT INTO dApostas (ID, Apelido, Jogo, Sel1, Sel2, Data, Horario, Ap1, Ap2) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
                args: [id, apelido, jogo.Jogo, jogo.Sel1, jogo.Sel2, jogo.Data, jogo.Horario]
            });
        }

        res.json({ success: true, message: "Cadastro e apostas criadas!" });
    } catch (e) {
        console.error("Erro no cadastro:", e);
        res.status(500).json({ success: false, message: "Erro ao processar base de dados." });
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
        
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] }); 
        } else {
            res.json({ success: false, message: "Credenciais incorretas." });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- PRESENÇA (PING) ---
app.post('/api/ping', async (req, res) => {
    const { apelido } = req.body;
    if (!apelido) return res.status(400).json({ success: false });

    try {
        // Atualiza a coluna InOut com o horário atual do servidor para marcar presença
        await db.execute({
            sql: "UPDATE dLogin SET InOut = datetime('now', 'localtime') WHERE Apelido = ?",
            args: [apelido]
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao registrar ping:", e);
        res.status(500).json({ success: false });
    }
});

// --- PALPITES ---
app.get('/minhas-apostas/:apelido', async (req, res) => {
    try {
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
    } catch (e) { 
        console.error("Erro ao salvar palpite:", e);
        res.status(500).json({ success: false }); 
    }
});

// --- CHAT (24 Horas) ---
app.get('/get-chat', async (req, res) => {
    try {
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

// --- ADMIN: JOGOS E RESULTADOS ---
app.get('/api/admin/jogos', async (req, res) => {
    try {
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

app.post('/api/admin/atualizar_resultado', async (req, res) => {
    const { jogo, res1, res2 } = req.body;
    const r1 = parseInt(res1);
    const r2 = parseInt(res2);

    try {
        await db.execute({
            sql: "INSERT INTO dResult (Jogo, Res1, Res2) VALUES (?, ?, ?) ON CONFLICT(Jogo) DO UPDATE SET Res1=excluded.Res1, Res2=excluded.Res2",
            args: [jogo, r1, r2]
        });

        const sqlCalculo = `
            UPDATE dApostas 
            SET Res1 = ?, Res2 = ?, 
                Pontos = CASE 
		    WHEN Ap1 IS NULL OR Ap2 IS NULL THEN 0
                    WHEN Ap1 = ? AND Ap2 = ? THEN 4 
                    WHEN (Ap1 > Ap2 AND ? > ?) OR (Ap1 < Ap2 AND ? < ?) OR (Ap1 = Ap2 AND ? = ?) THEN 2 
                    ELSE 0 
                END
            WHERE Jogo = ?
        `;
        await db.execute({
            sql: sqlCalculo,
            args: [r1, r2, r1, r2, r1, r2, r1, r2, r1, r2, jogo]
        });

        res.json({ success: true, message: "Resultado salvo e pontos calculados!" });
    } catch (e) {
        console.error("Erro ao calcular pontos:", e);
        res.status(500).json({ success: false });
    }
});

// --- RANKING GERAL COM STATUS ONLINE ---
app.get('/api/ranking', async (req, res) => {
    try {
        // Busca pontos e verifica se o último ping (InOut) foi nos últimos 5 minutos
        const result = await db.execute(`
            SELECT 
                l.Apelido, 
                SUM(IFNULL(a.Pontos, 0)) as Total,
                CASE 
                    WHEN l.InOut > datetime('now', '-5 minutes', 'localtime') THEN 1 
                    ELSE 0 
                END as Online
            FROM dLogin l
            LEFT JOIN dApostas a ON l.Apelido = a.Apelido
            GROUP BY l.Apelido
            ORDER BY Total DESC, l.Apelido ASC
        `);
        res.json({ success: true, ranking: result.rows });
    } catch (e) {
        console.error("Erro ao buscar ranking:", e);
        res.status(500).json({ success: false });
    }
});

/// Rota corrigida para buscar os palpites da galera
app.get('/api/palpites-galera', async (req, res) => {
    try {
        const query = "SELECT * FROM dApostas ORDER BY Data DESC, Horario DESC";
        
        // ALTERADO DE 'client' PARA 'db'
        const result = await db.execute(query); 

        const palpites = result.rows.map(row => ({
            Apelido: row.Apelido,
            Jogo: row.Jogo,
            Sel1: row.Sel1,
            Ap1: row.Ap1,
            Sel2: row.Sel2,
            Ap2: row.Ap2,
            Res1: row.Res1,
            Res2: row.Res2,
            Pontos: row.Pontos,
            Data: row.Data,
            Horario: row.Horario
        }));

        res.json({ success: true, palpites: palpites });

    } catch (error) {
        console.error("Erro ao buscar palpites da galera:", error);
        res.status(500).json({ success: false, message: "Erro interno no servidor" });
    }
});

// Rota para obter dados das estatísticas atualizada conforme as tabelas reais
app.get('/api/estatisticas', async (req, res) => {
    try {
	// 1. CRAVADOS e ACERTOS SIMPLES
        const queryCravados = `
            SELECT Apelido, 
		SUM(CASE WHEN Ap1 = Res1 AND Ap2 = Res2 THEN 1 ELSE 0 END) as cravados,
        	SUM(CASE WHEN Pontos > 0 AND (Ap1 != Res1 OR Ap2 != Res2) THEN 1 ELSE 0 END) as acertos_comuns            
	    FROM dApostas
            WHERE Res1 IS NOT NULL 
            GROUP BY Apelido
            HAVING (cravados + acertos_comuns) > 0
            ORDER BY cravados DESC, acertos_comuns DESC
        `;

        // 2. Consulta para TORCIDA (Pontos acumulados pelo TIME do usuário)
        // Busca o 'Time' na dLogin e soma os 'Pontos' da dApostas usando o 'Apelido' como chave
        const queryTorcida = `
            SELECT l.Time, SUM(a.Pontos) as pontos
            FROM dApostas a
            JOIN dLogin l ON a.Apelido = l.Apelido
            GROUP BY l.Time
            ORDER BY pontos DESC
        `;

        const rCravados = await db.execute(queryCravados);
        const rTorcida = await db.execute(queryTorcida);

        // Retorna os dados formatados para o Chart.js
        res.json({
            cravados: rCravados.rows,
            torcida: rTorcida.rows
        });
        
    } catch (error) {
        console.error("Erro ao processar estatísticas:", error);
        res.status(500).json({ error: "Erro interno ao buscar estatísticas" });
    }
});

// --- RANKING DA ZOEIRA (Sincronizado com as Tabelas Reais) ---
app.get('/api/zoeira', async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT 
                l.Apelido, 
                av.Imagem as arquivo_imagem,
                SUM(IFNULL(a.Pontos, 0)) as TotalPontos
            FROM dLogin l
            LEFT JOIN dApostas a ON l.Apelido = a.Apelido
            LEFT JOIN dAvatar av ON l.Avatar = av.Avatar
            GROUP BY l.Apelido
            ORDER BY TotalPontos DESC, l.Apelido ASC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error("Erro ao buscar ranking da zoeira:", error);
        res.status(500).json({ error: "Erro interno no servidor" });
    }
});

// Rota para processar o envio do e-mail
app.post('/enviar-teste', async (req, res) => {
    const { destinatario, mensagem } = req.body;

    // Configuração do Transportador (usando as variáveis do seu .env)
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: destinatario,
        subject: 'Teste de Envio - Sistema de Apostas',
        text: mensagem
    };

    try {
        await transporter.sendMail(mailOptions);
        res.send('<h1>E-mail enviado com sucesso!</h1><p>Você pode fechar esta aba agora.</p>');
    } catch (error) {
        console.error('Erro ao enviar:', error);
        res.status(500).send('Erro ao enviar e-mail: ' + error.message);
    }
});

app.post('/enviar-ranking', async (req, res) => {
    const { destinatario } = req.body;
    
    // URL do seu site no Render (ajuste para a sua URL real)
    const baseURL = "https://bolao-do-angeli-2026.onrender.com";

    try {
        const result = await db.execute(`
            SELECT 
                l.Apelido, 
                av.Imagem as arquivo_imagem,
                SUM(IFNULL(a.Pontos, 0)) as TotalPontos
            FROM dLogin l
            LEFT JOIN dApostas a ON l.Apelido = a.Apelido
            LEFT JOIN dAvatar av ON l.Avatar = av.Avatar
            GROUP BY l.Apelido
            ORDER BY TotalPontos DESC, l.Apelido ASC
        `);

        let linhasTabela = '';
        result.rows.forEach((user, index) => {
            // Monta o caminho completo da imagem
            // Supondo que suas imagens fiquem na pasta /public/images/ ou similar
            const urlImagem = `${baseURL}/images/${user.arquivo_imagem}`; 

            linhasTabela += `
                <tr>
                    <td style="padding: 12px; border-bottom: 1px solid #333; text-align: center; color: #888;">${index + 1}º</td>
                    <td style="padding: 12px; border-bottom: 1px solid #333; text-align: center;">
                        <img src="${urlImagem}" alt="avatar" width="35" height="35" style="border-radius: 50%; object-fit: cover; border: 1px solid #4CAF50;">
                    </td>
                    <td style="padding: 12px; border-bottom: 1px solid #333; font-weight: bold;">${user.Apelido}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #333; text-align: center; color: #4CAF50; font-weight: bold;">${user.TotalPontos}</td>
                </tr>`;
        });

        const corpoHtml = `
            <div style="background-color: #000; color: #fff; padding: 20px; font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: auto; border: 1px solid #4CAF50; border-radius: 15px;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h1 style="color: #4CAF50; margin: 0;">🏆 Ranking da Zoeira</h1>
                    <p style="font-size: 14px; color: #aaa;">Atualizado em: ${new Date().toLocaleDateString('pt-BR')}</p>
                </div>
                
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background-color: #1a1a1a;">
                            <th style="padding: 10px; border-bottom: 2px solid #4CAF50; text-align: center;">Pos</th>
                            <th style="padding: 10px; border-bottom: 2px solid #4CAF50; text-align: center;">Avatar</th>
                            <th style="padding: 10px; border-bottom: 2px solid #4CAF50; text-align: left;">Apelido</th>
                            <th style="padding: 10px; border-bottom: 2px solid #4CAF50; text-align: center;">Pts</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${linhasTabela}
                    </tbody>
                </table>
                
                <div style="text-align: center; margin-top: 30px; font-size: 12px; color: #555;">
                    <p>Este é um e-mail automático do Bolão do Angeli 2026.</p>
                </div>
            </div>
        `;

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: `"Bolão 2026" <${process.env.EMAIL_USER}>`,
            to: destinatario,
            subject: '🚀 Ranking da Zoeira Atualizado!',
            html: corpoHtml
        });

        res.send('<h1>Ranking da Zoeira enviado!</h1>');

    } catch (error) {
        console.error(error);
        res.status(500).send('Erro ao processar e-mail: ' + error.message);
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));