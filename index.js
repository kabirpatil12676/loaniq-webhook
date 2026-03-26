const express = require('express');
const cors = require('cors');
const dialogflow = require('@google-cloud/dialogflow');

const app = express();

app.use(cors());
app.use(express.json());

/* ============================================================
   LoanIQ Webhook + Chat Proxy
   
   /webhook  — Dialogflow fulfillment (called BY Dialogflow)
   /chat     — Frontend proxy (calls Dialogflow detectIntent)
   ============================================================ */

/* ─────────────── DIALOGFLOW CLIENT ─────────────── */

// Parse service account from environment variable
let dfClient = null;
let projectId = null;

try {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  projectId = creds.project_id || process.env.DIALOGFLOW_PROJECT_ID;
  
  if (creds.client_email) {
    dfClient = new dialogflow.SessionsClient({
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      projectId: projectId,
    });
    console.log('✅ Dialogflow client initialized for project:', projectId);
  } else {
    console.warn('⚠️ GOOGLE_CREDENTIALS not set — /chat endpoint will be unavailable');
  }
} catch (e) {
  console.error('❌ Failed to parse GOOGLE_CREDENTIALS:', e.message);
}

/* ─────────────── /chat — FRONTEND PROXY ─────────────── */

app.post('/chat', async (req, res) => {
  if (!dfClient || !projectId) {
    return res.status(500).json({
      error: 'Dialogflow not configured. Set GOOGLE_CREDENTIALS env var.',
    });
  }

  const { text, sessionId } = req.body;
  
  if (!text || !sessionId) {
    return res.status(400).json({ error: 'Missing text or sessionId' });
  }

  try {
    const sessionPath = dfClient.projectAgentSessionPath(projectId, sessionId);

    const [response] = await dfClient.detectIntent({
      session: sessionPath,
      queryInput: {
        text: {
          text: text,
          languageCode: 'en',
        },
      },
    });

    const qr = response.queryResult;

    // Extract texts and quick replies
    const messages = [];
    const chips = [];

    if (qr.fulfillmentMessages) {
      qr.fulfillmentMessages.forEach(m => {
        if (m.text && m.text.text) {
          m.text.text.filter(Boolean).forEach(t => messages.push(t));
        }
        if (m.quickReplies && m.quickReplies.quickReplies) {
          chips.push(...m.quickReplies.quickReplies);
        }
      });
    }

    if (messages.length === 0 && qr.fulfillmentText) {
      messages.push(qr.fulfillmentText);
    }

    return res.json({
      texts: messages,
      chips: chips,
      intent: qr.intent?.displayName || '',
    });
  } catch (error) {
    console.error('Dialogflow detectIntent error:', error.message);
    return res.status(500).json({ error: 'Failed to process message' });
  }
});

/* ─────────────── /chat/welcome — WELCOME EVENT ─────────────── */

app.post('/chat/welcome', async (req, res) => {
  if (!dfClient || !projectId) {
    return res.status(500).json({ error: 'Dialogflow not configured' });
  }

  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  try {
    const sessionPath = dfClient.projectAgentSessionPath(projectId, sessionId);

    const [response] = await dfClient.detectIntent({
      session: sessionPath,
      queryInput: {
        event: {
          name: 'WELCOME',
          languageCode: 'en',
        },
      },
    });

    const qr = response.queryResult;
    const messages = [];
    const chips = [];

    if (qr.fulfillmentMessages) {
      qr.fulfillmentMessages.forEach(m => {
        if (m.text && m.text.text) {
          m.text.text.filter(Boolean).forEach(t => messages.push(t));
        }
        if (m.quickReplies && m.quickReplies.quickReplies) {
          chips.push(...m.quickReplies.quickReplies);
        }
      });
    }

    if (messages.length === 0 && qr.fulfillmentText) {
      messages.push(qr.fulfillmentText);
    }

    return res.json({ texts: messages, chips: chips });
  } catch (error) {
    console.error('Welcome event error:', error.message);
    return res.status(500).json({ error: 'Failed to get welcome message' });
  }
});


/* ============================================================
   EMI CALCULATION
   ============================================================ */

function calculateEMI(principal, annualRate = 9, tenureMonths = 240) {
  const monthlyRate = annualRate / (12 * 100);
  const emi =
    (principal * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths)) /
    (Math.pow(1 + monthlyRate, tenureMonths) - 1);
  return emi;
}

/* ============================================================
   LOAN ELIGIBILITY ENGINE
   ============================================================ */

function calculateLoanEligibility(params) {
  let score = 0;
  const warnings = [];
  const tips = [];

  const totalIncome =
    parseFloat(params.applicant_income) +
    parseFloat(params.coapplicant_income || 0);

  const creditScore  = parseFloat(params.credit_score);
  const loanAmt      = parseFloat(params.loan_amount);
  const existingEMI  = parseFloat(params.existing_emi || 0);
  const age          = parseFloat(params.age);
  const dependents   = parseFloat(params.dependents || 0);

  const proposedEMI = calculateEMI(loanAmt);
  const totalEMI    = existingEMI + proposedEMI;
  const dtiRatio    = totalIncome > 0 ? (totalEMI / totalIncome) * 100 : 100;

  // CREDIT SCORE (30 pts)
  if (creditScore >= 750) {
    score += 30;
  } else if (creditScore >= 700) {
    score += 23;
    tips.push('Improve credit score to 750+ for best rates');
  } else if (creditScore >= 650) {
    score += 14;
    warnings.push('Moderate credit score (650–699) — lenders may add risk premium');
  } else {
    score += 4;
    warnings.push('Low credit score (below 650) — high rejection risk');
    tips.push('Pay down existing debts and clear any overdue EMIs to improve CIBIL');
  }

  // DTI RATIO (25 pts)
  if (dtiRatio <= 30) {
    score += 25;
  } else if (dtiRatio <= 40) {
    score += 18;
    tips.push('Debt-to-income ratio is moderate — consider reducing existing EMIs');
  } else if (dtiRatio <= 50) {
    score += 9;
    warnings.push(`High debt-to-income ratio (${dtiRatio.toFixed(1)}%) — most lenders prefer below 40%`);
    tips.push('Pre-close any existing loans to lower your DTI before applying');
  } else {
    score += 0;
    warnings.push(`Very high DTI (${dtiRatio.toFixed(1)}%) — strong rejection signal`);
    tips.push('Reduce loan amount or clear existing debts before applying');
  }

  // INCOME vs LOAN AMOUNT (20 pts)
  const ratio = loanAmt / totalIncome;
  if (ratio <= 20) {
    score += 20;
  } else if (ratio <= 40) {
    score += 14;
  } else if (ratio <= 60) {
    score += 7;
    warnings.push('Loan amount is high relative to your income');
    tips.push('Consider a co-applicant or a smaller loan to improve approval odds');
  } else {
    score += 2;
    warnings.push('Loan amount significantly exceeds income capacity');
    tips.push('Reduce the requested loan amount or increase co-applicant income');
  }

  // EMPLOYMENT TYPE (10 pts)
  const empMap = {
    salaried_government : 10,
    salaried_private    : 8,
    self_employed       : 6,
    freelancer          : 4,
    student_unemployed  : 1,
    'salaried govt'     : 10,
    'salaried private'  : 8,
    'self-employed'     : 6,
    unemployed          : 1,
    student             : 1,
  };
  const empKey = String(params.employment_status || '').toLowerCase().trim();
  score += empMap[empKey] ?? 4;

  // AGE (5 pts)
  if (age >= 25 && age <= 45) {
    score += 5;
  } else if (age >= 21 && age <= 55) {
    score += 3;
  } else {
    score += 1;
    if (age < 21)  warnings.push('Age below 21 — most lenders require minimum age of 21');
    if (age > 55)  warnings.push('Age above 55 — shorter available tenure may reduce eligibility');
  }

  // LOAN PURPOSE (5 pts)
  const purposeMap = {
    home_purchase    : 5,
    education        : 4,
    vehicle          : 4,
    business         : 3,
    home_renovation  : 3,
    personal         : 2,
    medical          : 2,
  };
  const purposeKey = String(params.loan_purpose || '').toLowerCase().trim();
  score += purposeMap[purposeKey] ?? 2;

  // DEPENDENTS (3 pts)
  if (dependents === 0) {
    score += 3;
  } else if (dependents <= 2) {
    score += 2;
  } else {
    score += 0;
    if (dependents > 3) warnings.push('High number of dependents reduces disposable income assessment');
  }

  // PROPERTY AREA (2 pts)
  const areaMap = {
    urban       : 2,
    semiurban   : 2,
    'semi-urban': 2,
    semi_urban  : 2,
    rural       : 1,
  };
  const areaKey = String(params.property_area || '').toLowerCase().trim();
  score += areaMap[areaKey] ?? 1;

  // FINAL
  const percentage = Math.min(Math.round(score), 100);

  let verdict, recommendation;
  if (percentage >= 80) {
    verdict        = '✅ Strong Approval Likely';
    recommendation = 'Your profile is strong. You can apply confidently at most lenders.';
  } else if (percentage >= 65) {
    verdict        = '🟡 Good Approval Chances';
    recommendation = 'Good profile. Address the minor concerns above for better interest rates.';
  } else if (percentage >= 50) {
    verdict        = '🟠 Conditional Eligibility';
    recommendation = 'You may qualify with a guarantor, higher down payment, or collateral.';
  } else if (percentage >= 35) {
    verdict        = '🔴 Low Approval Probability';
    recommendation = 'Improve your credit score and reduce existing debt before applying.';
  } else {
    verdict        = '❌ High Rejection Risk';
    recommendation = 'Significant financial profile improvement needed before applying.';
  }

  return {
    percentage, verdict, recommendation, warnings, tips,
    dtiRatio: dtiRatio.toFixed(1), totalIncome, emi: Math.round(proposedEMI),
  };
}

/* ─────────────── FORMAT MONEY ─────────────── */

function formatCurrency(amount) {
  const n = parseFloat(amount);
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)} Cr`;
  if (n >= 100000)   return `₹${(n / 100000).toFixed(1)} L`;
  if (n >= 1000)     return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
}

/* ============================================================
   /webhook — DIALOGFLOW FULFILLMENT
   ============================================================ */

app.post('/webhook', (req, res) => {
  const intentName     = req.body?.queryResult?.intent?.displayName;
  const parameters     = req.body?.queryResult?.parameters || {};
  const outputContexts = req.body?.queryResult?.outputContexts || [];

  let allParams = { ...parameters };

  outputContexts.forEach(ctx => {
    if (ctx.parameters) {
      const clean = {};
      Object.entries(ctx.parameters).forEach(([k, v]) => {
        if (!k.endsWith('.original')) clean[k] = v;
      });
      allParams = { ...allParams, ...clean };
    }
  });

  if (intentName !== 'loan.calculate.result') {
    return res.json({ fulfillmentText: 'Processing your information...' });
  }

  try {
    const required = ['age', 'applicant_income', 'credit_score', 'loan_amount'];
    const missing  = required.filter(f => !allParams[f] && allParams[f] !== 0);

    if (missing.length > 0) {
      console.warn('Missing fields:', missing);
      return res.json({
        fulfillmentText:
          `⚠️ Some information is missing (${missing.join(', ')}). Please type *Start* to begin again.`,
      });
    }

    const result = calculateLoanEligibility(allParams);
    const { percentage, verdict, recommendation, warnings, tips, dtiRatio, totalIncome, emi } = result;

    const filled = Math.round(percentage / 10);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);

    const msg1 =
`LOAN ELIGIBILITY RESULT

${verdict}
Score: ${percentage}%
[${bar}]

Income: ${formatCurrency(totalIncome)}
Loan: ${formatCurrency(allParams.loan_amount)}
EMI: ${formatCurrency(emi)}/month
DTI: ${dtiRatio}%`;

    let msg2 = recommendation;
    if (warnings.length > 0) {
      msg2 =
`⚠️ Key Concerns:
${warnings.map(w => `• ${w}`).join('\n')}

${recommendation}`;
    }

    const messages = [
      { text: { text: [msg1] } },
      { text: { text: [msg2] } },
    ];

    if (tips.length > 0) {
      const msg3 =
`💡 How to Improve Your Chances:

${tips.slice(0, 3).map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
      messages.push({ text: { text: [msg3] } });
    }

    messages.push({
      quickReplies: {
        quickReplies: ['Check Again 🔄', 'Improve Score 📈', 'Loan Tips 💡'],
      },
    });

    return res.json({
      fulfillmentText    : `${verdict} — ${percentage}%`,
      fulfillmentMessages: messages,
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.json({
      fulfillmentText: '⚠️ Something went wrong while calculating. Please type *Start* to try again.',
    });
  }
});

/* ─────────────── HEALTH CHECK ─────────────── */

app.get('/', (req, res) => res.send('LoanIQ Webhook Running ✅'));

/* ─────────────── SERVER ─────────────── */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LoanIQ webhook running on port ${PORT}`));

module.exports = app;
