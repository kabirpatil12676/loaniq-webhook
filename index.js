/**
 * LoanIQ Dialogflow Fulfillment Webhook
 * Loan Eligibility Scoring Engine
 * 
 * Deploy this on: Google Cloud Functions / Firebase Functions / Render / Railway
 * 
 * Based on ML features from Loan Approval Prediction project:
 * - Applicant_Income, Coapplicant_Income, Credit_Score, DTI_Ratio,
 *   Employment_Status, Marital_Status, Education_Level, Loan_Amount,
 *   Loan_Purpose, Property_Area, Age, Dependents, Savings
 */

const express = require('express');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// SCORING ENGINE
// ─────────────────────────────────────────────

function calculateLoanEligibility(params) {
  let score = 0;
  let maxScore = 0;
  const breakdown = [];
  const warnings = [];
  const tips = [];

  const {
    age,
    applicant_income,
    coapplicant_income,
    employment_status,
    credit_score,
    existing_emi,
    loan_amount,
    loan_purpose,
    dependents,
    property_area
  } = params;

  const totalIncome = parseFloat(applicant_income) + parseFloat(coapplicant_income || 0);
  const creditScore = parseFloat(credit_score);
  const loanAmt = parseFloat(loan_amount);
  const existingEMI = parseFloat(existing_emi || 0);
  const ageNum = parseFloat(age);
  const dependentsNum = parseFloat(dependents || 0);

  // ── 1. CREDIT SCORE (Max 30 points) ──────────────────
  maxScore += 30;
  if (creditScore >= 750) {
    score += 30;
    breakdown.push('✅ Credit Score (Excellent 750+): +30/30');
  } else if (creditScore >= 700) {
    score += 23;
    breakdown.push('🟡 Credit Score (Good 700-749): +23/30');
    tips.push('Improving your credit score to 750+ can significantly boost approval chances.');
  } else if (creditScore >= 650) {
    score += 14;
    breakdown.push('🟠 Credit Score (Fair 650-699): +14/30');
    warnings.push('Credit score is below ideal. Work on paying dues on time.');
    tips.push('Pay all EMIs on time for 6+ months to see credit score improvement.');
  } else {
    score += 4;
    breakdown.push('🔴 Credit Score (Poor <650): +4/30');
    warnings.push('Low credit score is the biggest risk factor for rejection.');
    tips.push('Focus on credit score improvement before applying — aim for 700+.');
  }

  // ── 2. DTI RATIO - Debt-to-Income (Max 25 points) ────
  maxScore += 25;
  const proposedEMI = loanAmt / 120; // Approximate EMI for 10-year tenure
  const totalEMI = existingEMI + proposedEMI;
  const dtiRatio = totalIncome > 0 ? (totalEMI / totalIncome) * 100 : 100;

  if (dtiRatio <= 30) {
    score += 25;
    breakdown.push(`✅ Debt-to-Income Ratio (${dtiRatio.toFixed(1)}%): +25/25`);
  } else if (dtiRatio <= 40) {
    score += 18;
    breakdown.push(`🟡 Debt-to-Income Ratio (${dtiRatio.toFixed(1)}%): +18/25`);
    tips.push('Try to reduce your total EMI commitments to below 40% of income.');
  } else if (dtiRatio <= 50) {
    score += 9;
    breakdown.push(`🟠 Debt-to-Income Ratio (${dtiRatio.toFixed(1)}%): +9/25`);
    warnings.push('High debt burden. Banks may find this risky.');
    tips.push('Pay off some existing loans before applying to improve your DTI ratio.');
  } else {
    score += 0;
    breakdown.push(`🔴 Debt-to-Income Ratio (${dtiRatio.toFixed(1)}% — Too High): +0/25`);
    warnings.push('DTI ratio exceeds 50%. Most lenders will reject this application.');
    tips.push('Reduce loan amount requested OR clear existing debts first.');
  }

  // ── 3. INCOME ADEQUACY (Max 20 points) ───────────────
  maxScore += 20;
  const incomeToLoanRatio = totalIncome > 0 ? loanAmt / totalIncome : 9999;

  if (incomeToLoanRatio <= 20) {
    score += 20;
    breakdown.push('✅ Income vs Loan Amount: +20/20');
  } else if (incomeToLoanRatio <= 40) {
    score += 14;
    breakdown.push('🟡 Income vs Loan Amount (Moderate): +14/20');
  } else if (incomeToLoanRatio <= 60) {
    score += 7;
    breakdown.push('🟠 Income vs Loan Amount (Stretched): +7/20');
    warnings.push('Loan amount is very high relative to income. Consider reducing the amount.');
    tips.push('Adding a co-applicant with steady income can help reduce this ratio.');
  } else {
    score += 2;
    breakdown.push('🔴 Income vs Loan Amount (Very High): +2/20');
    warnings.push('Loan amount far exceeds what your income can support.');
  }

  // ── 4. EMPLOYMENT STATUS (Max 10 points) ─────────────
  maxScore += 10;
  const empMap = {
    'salaried_government': { pts: 10, label: 'Government Salaried' },
    'salaried_private': { pts: 8, label: 'Private Salaried' },
    'self_employed': { pts: 6, label: 'Self-Employed' },
    'freelancer': { pts: 4, label: 'Freelancer/Consultant' },
    'student_unemployed': { pts: 1, label: 'Student/Unemployed' }
  };
  const emp = empMap[employment_status] || { pts: 4, label: 'Other' };
  score += emp.pts;
  breakdown.push(`${emp.pts >= 8 ? '✅' : emp.pts >= 5 ? '🟡' : '🔴'} Employment (${emp.label}): +${emp.pts}/10`);
  if (emp.pts <= 4) {
    warnings.push('Unstable or no employment reduces lender confidence significantly.');
    tips.push('A co-applicant with stable income can compensate for employment type.');
  }

  // ── 5. AGE FACTOR (Max 5 points) ─────────────────────
  maxScore += 5;
  if (ageNum >= 25 && ageNum <= 45) {
    score += 5;
    breakdown.push('✅ Age (Prime Working Age 25-45): +5/5');
  } else if ((ageNum >= 21 && ageNum < 25) || (ageNum > 45 && ageNum <= 55)) {
    score += 3;
    breakdown.push('🟡 Age (Acceptable Range): +3/5');
  } else if (ageNum >= 18 && ageNum < 21) {
    score += 1;
    breakdown.push('🟠 Age (Very Young, <21): +1/5');
    warnings.push('Being under 21 limits loan options — consider waiting or using a guarantor.');
  } else if (ageNum > 55) {
    score += 2;
    breakdown.push('🟠 Age (Above 55): +2/5');
    tips.push('Lenders may offer shorter tenure due to age. Factor this into EMI planning.');
  } else {
    breakdown.push('🔴 Age (Invalid): +0/5');
    warnings.push('Age entered may be invalid. Please verify.');
  }

  // ── 6. LOAN PURPOSE RISK (Max 5 points) ──────────────
  maxScore += 5;
  const purposeMap = {
    'home_purchase': { pts: 5, label: 'Home Purchase (Secured)' },
    'home_renovation': { pts: 4, label: 'Home Renovation' },
    'education': { pts: 4, label: 'Education (Priority)' },
    'vehicle': { pts: 4, label: 'Vehicle (Secured)' },
    'business': { pts: 3, label: 'Business (Moderate Risk)' },
    'medical': { pts: 3, label: 'Medical Emergency' },
    'personal': { pts: 2, label: 'Personal Use (Unsecured)' }
  };
  const purpose = purposeMap[loan_purpose] || { pts: 2, label: 'Other' };
  score += purpose.pts;
  breakdown.push(`${purpose.pts >= 4 ? '✅' : '🟡'} Loan Purpose (${purpose.label}): +${purpose.pts}/5`);

  // ── 7. DEPENDENTS (Max 3 points) ─────────────────────
  maxScore += 3;
  if (dependentsNum === 0) {
    score += 3;
    breakdown.push('✅ Dependents (None): +3/3');
  } else if (dependentsNum <= 2) {
    score += 2;
    breakdown.push('🟡 Dependents (1-2): +2/3');
  } else {
    score += 0;
    breakdown.push('🟠 Dependents (3+): +0/3');
    warnings.push('Higher dependents increase perceived financial burden on the applicant.');
  }

  // ── 8. PROPERTY AREA (Max 2 points) ──────────────────
  maxScore += 2;
  const areaMap = {
    'urban': { pts: 2, label: 'Urban' },
    'semiurban': { pts: 2, label: 'Semi-Urban' },
    'rural': { pts: 1, label: 'Rural' }
  };
  const area = areaMap[property_area] || { pts: 1, label: 'Unknown' };
  score += area.pts;
  breakdown.push(`✅ Property Area (${area.label}): +${area.pts}/2`);

  // ── FINAL PERCENTAGE ──────────────────────────────────
  const percentage = Math.round((score / maxScore) * 100);

  // ── VERDICT ───────────────────────────────────────────
  let verdict = '';
  let emoji = '';
  let recommendation = '';

  if (percentage >= 80) {
    verdict = 'STRONG APPROVAL';
    emoji = '🟢';
    recommendation = 'Your profile is highly competitive. You are very likely to get approved. Apply with confidence! Compare rates across banks before choosing.';
  } else if (percentage >= 65) {
    verdict = 'LIKELY APPROVED';
    emoji = '🟡';
    recommendation = 'Good chances of approval. You may want to address any warnings above before applying to get better interest rates.';
  } else if (percentage >= 50) {
    verdict = 'CONDITIONALLY ELIGIBLE';
    emoji = '🟠';
    recommendation = 'Borderline case — you may be approved with conditions (higher interest, guarantor, or reduced amount). Work on improving weaknesses first.';
  } else if (percentage >= 35) {
    verdict = 'HIGH RISK OF REJECTION';
    emoji = '🔴';
    recommendation = 'Significant improvements needed. Focus on credit score and debt reduction before applying to avoid rejection marks on your credit report.';
  } else {
    verdict = 'LIKELY REJECTED';
    emoji = '❌';
    recommendation = 'Multiple strong risk factors identified. Immediate improvements required — especially credit score and DTI ratio. Consider waiting 6-12 months.';
  }

  return {
    percentage,
    score,
    maxScore,
    verdict,
    emoji,
    recommendation,
    breakdown,
    warnings,
    tips,
    dtiRatio: dtiRatio.toFixed(1),
    totalIncome
  };
}

// ─────────────────────────────────────────────
// FORMAT CURRENCY
// ─────────────────────────────────────────────
function formatCurrency(amount) {
  const num = parseFloat(amount);
  if (num >= 10000000) return `₹${(num / 10000000).toFixed(2)} Cr`;
  if (num >= 100000) return `₹${(num / 100000).toFixed(2)} L`;
  if (num >= 1000) return `₹${(num / 1000).toFixed(1)}K`;
  return `₹${num}`;
}

// ─────────────────────────────────────────────
// BUILD RESULT MESSAGE
// ─────────────────────────────────────────────
function buildResultMessage(result, params) {
  const { percentage, verdict, emoji, recommendation, breakdown, warnings, tips, dtiRatio, totalIncome } = result;

  // Progress bar
  const filled = Math.round(percentage / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  let message = `🎯 *LOAN ELIGIBILITY RESULT*\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  message += `${emoji} *${verdict}*\n`;
  message += `📊 Approval Probability: *${percentage}%*\n`;
  message += `[${bar}] ${percentage}%\n\n`;

  message += `📋 *Your Summary:*\n`;
  message += `• Total Monthly Income: ${formatCurrency(totalIncome)}\n`;
  message += `• Loan Requested: ${formatCurrency(params.loan_amount)}\n`;
  message += `• Debt-to-Income Ratio: ${dtiRatio}%\n`;
  message += `• Credit Score: ${params.credit_score}\n\n`;

  message += `📈 *Score Breakdown:*\n`;
  breakdown.forEach(b => { message += `${b}\n`; });
  message += `\n`;

  if (warnings.length > 0) {
    message += `⚠️ *Key Concerns:*\n`;
    warnings.forEach(w => { message += `• ${w}\n`; });
    message += `\n`;
  }

  message += `💬 *Recommendation:*\n${recommendation}\n\n`;

  if (tips.length > 0) {
    message += `💡 *Top Tips for You:*\n`;
    tips.slice(0, 3).forEach((t, i) => { message += `${i + 1}. ${t}\n`; });
    message += `\n`;
  }

  message += `━━━━━━━━━━━━━━━━━━━━\n`;
  message += `⚠️ *Disclaimer:* This is an AI-based estimate. Actual approval depends on lender policies and verification of documents.\n\n`;
  message += `Would you like to try another scenario or get more tips?`;

  return message;
}

// ─────────────────────────────────────────────
// WEBHOOK HANDLER
// ─────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  const intentName = req.body.queryResult.intent.displayName;
  const parameters = req.body.queryResult.parameters;
  const outputContexts = req.body.queryResult.outputContexts || [];

  // Collect all parameters from contexts
  let allParams = { ...parameters };
  outputContexts.forEach(ctx => {
    if (ctx.parameters) {
      allParams = { ...allParams, ...ctx.parameters };
    }
  });

  // ── Handle calculate result intent ──
  if (intentName === 'loan.calculate.result') {
    try {
      // Validate required fields
      const required = ['age', 'applicant_income', 'credit_score', 'loan_amount'];
      const missing = required.filter(f => !allParams[f]);

      if (missing.length > 0) {
        return res.json({
          fulfillmentText: `⚠️ Some information seems to be missing (${missing.join(', ')}). Let's start over to ensure accurate results.`,
          fulfillmentMessages: [
            {
              text: { text: [`⚠️ Some information seems to be missing. Let's start over for accurate results.`] }
            },
            {
              quickReplies: {
                quickReplies: ['Start over 🔄', 'Help']
              }
            }
          ]
        });
      }

      // Validate ranges
      const creditScore = parseFloat(allParams.credit_score);
      const age = parseFloat(allParams.age);
      const income = parseFloat(allParams.applicant_income);

      if (creditScore < 300 || creditScore > 900) {
        return res.json({
          fulfillmentText: `⚠️ Credit score of ${creditScore} seems invalid. Credit scores range from 300–900. Please start over and enter a valid score.`,
          fulfillmentMessages: [
            { text: { text: [`⚠️ Credit score of ${creditScore} is invalid (valid range: 300–900). Please try again.`] } },
            { quickReplies: { quickReplies: ['Start over 🔄'] } }
          ]
        });
      }

      if (age < 18 || age > 75) {
        return res.json({
          fulfillmentText: `⚠️ Age ${age} is outside the eligible range (18–75 years) for most loan products.`,
          fulfillmentMessages: [
            { text: { text: [`⚠️ Age ${age} is outside the eligible range (18–75 years).`] } },
            { quickReplies: { quickReplies: ['Start over 🔄'] } }
          ]
        });
      }

      if (income <= 0) {
        return res.json({
          fulfillmentText: `⚠️ Income must be greater than 0 for a loan application.`,
          fulfillmentMessages: [
            { text: { text: [`⚠️ Please enter a valid income greater than 0.`] } },
            { quickReplies: { quickReplies: ['Start over 🔄'] } }
          ]
        });
      }

      const result = calculateLoanEligibility(allParams);
      const message = buildResultMessage(result, allParams);

      return res.json({
        fulfillmentText: message,
        fulfillmentMessages: [
          { text: { text: [message] } },
          {
            quickReplies: {
              quickReplies: [
                'Check again 🔄',
                'Tips to improve 💡',
                'What is credit score?',
                'Share this bot'
              ]
            }
          }
        ]
      });

    } catch (error) {
      console.error('Scoring error:', error);
      return res.json({
        fulfillmentText: '❌ Something went wrong while calculating. Please start over.',
        fulfillmentMessages: [
          { text: { text: ['❌ Calculation error. Please start over.'] } },
          { quickReplies: { quickReplies: ['Start over 🔄'] } }
        ]
      });
    }
  }

  // Default fallback for webhook
  return res.json({
    fulfillmentText: "I'm processing your request. Please continue."
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('LoanIQ Webhook is running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LoanIQ webhook running on port ${PORT}`);
});

module.exports = app;
