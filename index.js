const express = require('express');
const app = express();
app.use(express.json());

/* ---------------- EMI CALCULATION ---------------- */

function calculateEMI(principal, annualRate = 9, tenureMonths = 240) {
  const monthlyRate = annualRate / (12 * 100);

  const emi =
    (principal *
      monthlyRate *
      Math.pow(1 + monthlyRate, tenureMonths)) /
    (Math.pow(1 + monthlyRate, tenureMonths) - 1);

  return emi;
}

/* ---------------- LOAN ELIGIBILITY ENGINE ---------------- */

function calculateLoanEligibility(params) {

  let score = 0;
  const maxScore = 100;

  const warnings = [];
  const tips = [];
  const breakdown = [];

  const totalIncome =
    parseFloat(params.applicant_income) +
    parseFloat(params.coapplicant_income || 0);

  const creditScore = parseFloat(params.credit_score);
  const loanAmt = parseFloat(params.loan_amount);
  const existingEMI = parseFloat(params.existing_emi || 0);
  const age = parseFloat(params.age);
  const dependents = parseFloat(params.dependents || 0);

  /* -------- EMI + DTI -------- */

  const proposedEMI = calculateEMI(loanAmt);
  const totalEMI = existingEMI + proposedEMI;

  const dtiRatio = totalIncome > 0 ? (totalEMI / totalIncome) * 100 : 100;

  /* -------- CREDIT SCORE (30) -------- */

  if (creditScore >= 750) {
    score += 30;
    breakdown.push("Excellent Credit Score +30");
  } else if (creditScore >= 700) {
    score += 23;
    tips.push("Improve credit score to 750+");
  } else if (creditScore >= 650) {
    score += 14;
    warnings.push("Moderate credit score");
  } else {
    score += 4;
    warnings.push("Low credit score");
  }

  /* -------- DTI (25) -------- */

  if (dtiRatio <= 30) {
    score += 25;
  } else if (dtiRatio <= 40) {
    score += 18;
    tips.push("Reduce EMI burden");
  } else if (dtiRatio <= 50) {
    score += 9;
    warnings.push("High debt ratio");
  } else {
    warnings.push("Very high debt ratio");
  }

  /* -------- INCOME VS LOAN (20) -------- */

  const ratio = loanAmt / totalIncome;

  if (ratio <= 20) score += 20;
  else if (ratio <= 40) score += 14;
  else if (ratio <= 60) {
    score += 7;
    warnings.push("Loan high compared to income");
  }
  else {
    score += 2;
    warnings.push("Loan too high");
  }

  /* -------- EMPLOYMENT (10) -------- */

  const empMap = {
    salaried_government: 10,
    salaried_private: 8,
    self_employed: 6,
    freelancer: 4,
    unemployed: 1
  };

  score += empMap[params.employment_status] || 4;

  /* -------- AGE (5) -------- */

  if (age >= 25 && age <= 45) score += 5;
  else if (age >= 21 && age <= 55) score += 3;
  else score += 1;

  /* -------- PURPOSE (5) -------- */

  const purposeMap = {
    home_purchase: 5,
    education: 4,
    vehicle: 4,
    business: 3,
    personal: 2
  };

  score += purposeMap[params.loan_purpose] || 2;

  /* -------- DEPENDENTS (3) -------- */

  if (dependents === 0) score += 3;
  else if (dependents <= 2) score += 2;

  /* -------- PROPERTY AREA (2) -------- */

  const areaMap = {
    urban: 2,
    semiurban: 2,
    rural: 1
  };

  score += areaMap[params.property_area] || 1;

  const percentage = Math.round((score / maxScore) * 100);

  /* -------- VERDICT -------- */

  let verdict;
  let recommendation;

  if (percentage >= 80) {
    verdict = "Strong Approval Likely";
    recommendation = "Your profile is strong. Apply confidently.";
  }

  else if (percentage >= 65) {
    verdict = "Good Approval Chances";
    recommendation = "Improve minor issues for better rates.";
  }

  else if (percentage >= 50) {
    verdict = "Conditional Eligibility";
    recommendation = "You may need guarantor or higher interest.";
  }

  else if (percentage >= 35) {
    verdict = "Low Approval Probability";
    recommendation = "Improve credit score and reduce debt.";
  }

  else {
    verdict = "High Rejection Risk";
    recommendation = "Improve financial profile before applying.";
  }

  return {
    percentage,
    verdict,
    recommendation,
    warnings,
    tips,
    dtiRatio: dtiRatio.toFixed(1),
    totalIncome,
    emi: Math.round(proposedEMI)
  };
}

/* ---------------- FORMAT MONEY ---------------- */

function formatCurrency(amount) {

  const n = parseFloat(amount);

  if (n >= 10000000) return `₹${(n/10000000).toFixed(1)} Cr`;
  if (n >= 100000) return `₹${(n/100000).toFixed(1)} L`;
  if (n >= 1000) return `₹${(n/1000).toFixed(0)}K`;

  return `₹${n}`;
}

/* ---------------- WEBHOOK ---------------- */

app.post('/webhook', (req, res) => {

  const intentName = req.body.queryResult.intent.displayName;
  const parameters = req.body.queryResult.parameters;
  const outputContexts = req.body.queryResult.outputContexts || [];

  let allParams = { ...parameters };

  outputContexts.forEach(ctx => {
    if (ctx.parameters)
      allParams = { ...allParams, ...ctx.parameters };
  });

  if (intentName !== 'loan.calculate.result') {
    return res.json({
      fulfillmentText: "Processing..."
    });
  }

  try {

    const required = [
      'age',
      'applicant_income',
      'credit_score',
      'loan_amount'
    ];

    const missing = required.filter(
      f => !allParams[f] || allParams[f] === ''
    );

    if (missing.length > 0) {

      return res.json({
        fulfillmentText:
          "Some information missing. Start again."
      });
    }

    const result =
      calculateLoanEligibility(allParams);

    const {
      percentage,
      verdict,
      recommendation,
      warnings,
      tips,
      dtiRatio,
      totalIncome,
      emi
    } = result;

    const filled =
      Math.round(percentage / 10);

    const bar =
      '█'.repeat(filled) +
      '░'.repeat(10 - filled);

    const msg1 =
`LOAN ELIGIBILITY RESULT

${verdict}
Score: ${percentage}%
[${bar}]

Income: ${formatCurrency(totalIncome)}
Loan: ${formatCurrency(allParams.loan_amount)}
EMI: ${formatCurrency(emi)}
DTI: ${dtiRatio}%`;

    let msg2 = recommendation;

    if (warnings.length > 0) {

      msg2 =
`Concerns:
${warnings.map(w => `- ${w}`).join('\n')}

${recommendation}`;
    }

    const messages = [
      { text: { text: [msg1] } },
      { text: { text: [msg2] } }
    ];

    if (tips.length > 0) {

      const msg3 =
`Improve Approval Chances:

${tips.slice(0,3)
.map((t,i)=>`${i+1}. ${t}`)
.join('\n')}`;

      messages.push({
        text: { text: [msg3] }
      });
    }

    messages.push({
      quickReplies: {
        quickReplies: [
          "Check Again",
          "Improve Score",
          "Loan Tips"
        ]
      }
    });

    return res.json({

      fulfillmentText:
      `${verdict} - ${percentage}%`,

      fulfillmentMessages: messages

    });

  }

  catch(error) {

    console.error(error);

    return res.json({

      fulfillmentText:
      "Something went wrong"

    });

  }

});

/* ---------------- HEALTH CHECK ---------------- */

app.get('/', (req, res) =>
  res.send('LoanIQ Running')
);

/* ---------------- SERVER ---------------- */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(
    `Server running ${PORT}`
  )
);

module.exports = app;
