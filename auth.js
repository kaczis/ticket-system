const express = require("express");
const serverless = require("serverless-http");
const { body, validationResult } = require('express-validator');
const { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, AdminInitiateAuthCommand, RespondToAuthChallengeCommand } = require("@aws-sdk/client-cognito-identity-provider");

const { REGION, CLIENT_ID, USER_POOL_ID } = process.env;
const clientCognito = new CognitoIdentityProviderClient({ region: REGION });

const app = express();

app.use(express.json());

const router = express.Router();

router.post(
    "/login", 
    body('email').isEmail(), 
    body('password').notEmpty(), 
    async (req, res) => {
        const result = validationResult(req);
        if (!result.isEmpty()) {
            return res.status(500).json({ errors: result.array() });
        }

        const params = {
            AuthFlow: "ADMIN_NO_SRP_AUTH",
            UserPoolId: USER_POOL_ID,
            ClientId: CLIENT_ID,
            AuthParameters: {
                USERNAME: req.body.email,
                PASSWORD: req.body.password
            }
        };

        try {
            const command = new AdminInitiateAuthCommand(params);
            const response = await clientCognito.send(command);

            if (response.ChallengeName) {
                res.status(200).json({ 
                    ChallengeName: response.ChallengeName,
                    Session: response.Session
                });
            } else {
                res.status(200).json({ ...response.AuthenticationResult });
            }
        } catch(error) {
            console.log(error);

            res.status(500).json({ 
                message: "Nie udało Ci się zalogować",
                error: error.message
            });
        }
    });

router.post(
    "/register", 
    body('email').isEmail(), 
    body('password').notEmpty(), 
    async (req, res) => {
        const result = validationResult(req);
        if (!result.isEmpty()) {
            return res.status(500).json({ errors: result.array() });
        }

        const params = {
            ClientId: CLIENT_ID,
            Username: req.body.email,
            Password: req.body.password,
            UserAttributes: [{
                Name: "email",
                Value: req.body.email
            }]
        }
    
        try {
            const command = new SignUpCommand(params);
            const response = await clientCognito.send(command);

            res.status(200).json({ sub: response.UserSub});
        } catch(error) {
            console.log(error);

            res.status(500).json({ 
                message: "Nie udało Ci się zarejestrować",
                error: error.message
            });
        }
    });

router.post(
    "/new-password", 
    body('email').isEmail(), 
    body('password').notEmpty(),
    body('session').notEmpty(), 
    async (req, res) => {
        const result = validationResult(req);
        if (!result.isEmpty()) {
            return res.status(500).json({ errors: result.array() });
        }
    
        const params = {
            ClientId: CLIENT_ID,
            ChallengeName: "NEW_PASSWORD_REQUIRED",
            Session: req.body.session,
            ChallengeResponses: {
                USERNAME: req.body.email,
                NEW_PASSWORD: req.body.password
            }    
        }
        
        try {
            const command = new RespondToAuthChallengeCommand(params);
            const response = await clientCognito.send(command);

            res.status(200).json({ ...response.AuthenticationResult });
        } catch(error) {
            console.log(error);
    
            res.status(500).json({ 
                message: "Nie udało Ci się zmienić hasłą",
                error: error.message
            });
        }
    });

router.post(
    "/confirm",
    body('email').isEmail(), 
    body('code').notEmpty(), 
    async (req, res) => {
        const result = validationResult(req);
        if (!result.isEmpty()) {
            return res.status(500).json({ errors: result.array() });
        }

        const params = {
            ClientId: CLIENT_ID,
            Username: req.body.email,
            ConfirmationCode: req.body.code,
        };

        try {
            const command = new ConfirmSignUpCommand(params);
            const response = await clientCognito.send(command);

            console.log(response)

            res.status(200).json({ message: "Uzytkownik potwierdzony" });
        } catch(error) {
            console.log(error);

            res.status(500).json({ 
                message: "Nie udało Ci się potwierdzić uzytkownika",
                error: error.message
            });
        }
    });

app.use('/auth', router)

app.use((req, res, next) => {
  return res.status(404).json({
    error: "Not Found",
  });
});

exports.handler = serverless(app);
