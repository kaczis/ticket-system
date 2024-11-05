const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { body, validationResult } = require('express-validator');

const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const REGION = process.env.REGION;

const s3Client = new S3Client({region: REGION})
const sqsClient = new SQSClient({region: REGION})
const sesClient = new SESClient({region: REGION})
const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);

const express = require("express");
const serverless = require("serverless-http");
const { v4: uuidv4 } = require("uuid");
const jwt = require('jsonwebtoken');

const app = express();

const TICKETS_TABLE = process.env.TICKETS_TABLE;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

const TICKET_STATUS = {
  NEW: "NEW",
  OPEN: "OPEN",
  CLOSED: "CLOSED"
};

const ROLES = {
  ADMIN: "ADMIN",
  USER: "USER"
}

app.use(express.json());

const router = express.Router();

function checkUser(req, res, next) {
  const token = req.headers.authorization.split(' ')[1];

  try {
    const decoded = jwt.decode(token);
    const groups = decoded['cognito:groups'];
    let role = ROLES.USER;

    if (groups && groups.includes('ADMIN')) {
      role = ROLES.ADMIN;
    }

    req.user = {
      sub: decoded.sub,
      role: role
    };

    next();
    
  } catch(error) {
    res.status(401).json({ 
      message: "Zły token",
      error: error.message
    });
  }
}

router.post(
  "/create", 
  checkUser,
  body('title').notEmpty(), 
  body('description').notEmpty(), 
  async (req, res) => {
      const result = validationResult(req);
      if (!result.isEmpty()) {
          return res.status(500).json({ errors: result.array() });
      }

      const {title, description, attachment } = req.body;
      const ticketId = uuidv4();

      let params = {
        TableName: TICKETS_TABLE,
        Item: {
          ticketId: ticketId,
          userSub: req.user.sub,
          createdAt: Date.now(),
          title: title,
          description: description,
          status: TICKET_STATUS.NEW
        },
      };

      if (attachment) {
        const buffer = Buffer.from(attachment, 'base64');
        const BUCKET_NAME = process.env.BUCKET_NAME;
        const fileName = `uploads/${Date.now()}-image.jpeg`

        const paramsS3 = {
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: buffer,
            ContentType: "image/jpeg",
            ACL: "public-read"
        }

        const command = new PutObjectCommand(paramsS3);
        await s3Client.send(command);

        params = {
          ...params,
          Item: {
            ...params.Item,
            attachment: `https://${BUCKET_NAME}.s3.amazonaws.com/${fileName}`
          }
        };
      }

      try {
        const command = new PutCommand(params);
        await docClient.send(command);

        const messageParams = {
          QueueUrl: process.env.SQS_QUEUE,
          MessageBody: JSON.stringify({
            ticketId,
            title, 
            description
          })
        }

        await sqsClient.send(new SendMessageCommand(messageParams));

        res.status(200).json({
          ...params.Item
        });
      } catch(error) {
          console.log(error);

          res.status(500).json({ 
              message: "Nie udało Ci się utworzyć ticketu",
              error: error.message
          });
      }
  });

  router.get(
    "/all", 
    checkUser,
    async (req, res) => {
        const user = req.user;
        let params = {
          TableName: TICKETS_TABLE,
          ScanIndexForward: true
        };

        const getTicketsByStatus = async (status) => {
          params = {
            ...params,
            IndexName: "StatusIndex",
            KeyConditionExpression: "#status = :statusValue",
            ExpressionAttributeNames: {
              "#status": "status"
            },
            ExpressionAttributeValues: {
              ":statusValue": status
            }
          }

          const command = new QueryCommand(params);
          return await docClient.send(command);
        }

        try {
          if (user.role === ROLES.ADMIN) {
            const ticketsOpen = await getTicketsByStatus(TICKET_STATUS.OPEN);
            const ticketsNew = await getTicketsByStatus(TICKET_STATUS.NEW);
     
            res.status(200).json({
              ticketsOpen: {
                count: ticketsOpen.Count,
                tickets: ticketsOpen.Items
              },
              ticketsNew: {
                count: ticketsNew.Count,
                tickets: ticketsNew.Items
              }
            });
          } else {
            params = {
              ...params,
              IndexName: "UserSubIndex",
              KeyConditionExpression: "#userSub = :userSubValue",
              ExpressionAttributeNames: {
                "#userSub": "userSub"
              },
              ExpressionAttributeValues: {
                ":userSubValue": user.sub
              }
            }

            const command = new QueryCommand(params);
            const data = await docClient.send(command);
     
            res.status(200).json({
              count: data.Count,
              tickets: data.Items
            });
          }
        } catch(error) {
            console.log(error);
  
            res.status(500).json({ 
                message: "Nie udało Ci się pobrać listy ticketów",
                error: error.message
            });
        }
    });

    router.post(
      "/updateStatus", 
      checkUser,
      body('ticketId').notEmpty(),
      body('status').isIn([TICKET_STATUS.OPEN, TICKET_STATUS.CLOSED]), 
      async (req, res) => {
          const result = validationResult(req);
          if (!result.isEmpty()) {
              return res.status(500).json({ errors: result.array() });
          }

          if (req.user.role !== ROLES.ADMIN) {
            return res.status(403).json({ message: 'Brak uprawnien' });
          }

          const { ticketId, status } = req.body;
        
          const params = {
            TableName: TICKETS_TABLE,
            Key: {
                ticketId: ticketId,
            },
            UpdateExpression: "set #status = :statusValue",
            ExpressionAttributeNames: {
              "#status": "status"
            },
            ExpressionAttributeValues: {
              ":statusValue": status
            },
            ReturnValue: "UPDATE_NEW"
          };
    
          try {
            const command = new UpdateCommand(params);
            await docClient.send(command);
    
            res.status(200).json({
              status: status
            });
          } catch(error) {
              console.log(error);
    
              res.status(500).json({ 
                  message: "Nie udało Ci się zmienić statusu",
                  error: error.message
              });
          }
      });

// app.get("/ticket/users/:userId", async (req, res) => {
//   const params = {
//     TableName: USERS_TABLE,
//     Key: {
//       userId: req.params.userId,
//     },
//   };

//   try {
//     const command = new GetCommand(params);
//     const { Item } = await docClient.send(command);
//     if (Item) {
//       const { userId, name } = Item;
//       res.json({ userId, name });
//     } else {
//       res
//         .status(404)
//         .json({ error: 'Could not find user with provided "userId"' });
//     }
//   } catch (error) {
//     console.log(error);
//     res.status(500).json({ error: "Could not retrieve user" });
//   }
// });

app.use('/ticket', router)

app.use((req, res, next) => {
  return res.status(404).json({
    error: "Not Found",
  });
});

exports.handler = serverless(app);

exports.processQueue = async (event) => {
  for (const record of event.Records) {
    const {ticketId, title, description} = JSON.parse(record.body);

    const params = {
      Destination: {
        ToAddresses: [ADMIN_EMAIL]
      },
      Message: {
        Body: {
          Text: {
            Data: `Ticket dodany w Twoim systemie \n ID: ${ticketId} \n Title: ${title} \n ${description}`
          }
        },
        Subject: {Data: "W Twoim systemie pojawił się nowy ticket"}
      },
      Source: ADMIN_EMAIL
    }

    try {
      await sesClient.send(new SendEmailCommand(params));
      console.log("Email wysłany");
    } catch(error) {
      console.error(error);
    }
  }
}

exports.dailyTicketReminder = async (event) => {
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  const startOfDay = new Date(oneDayAgo.setHours(0, 0, 0, 0)).getTime();

  const params = {
    TableName: TICKETS_TABLE,
    ScanIndexForward: true,
    IndexName: "StatusIndex",
    KeyConditionExpression: "#status = :statusValue AND #createdAt < :startOfDay",
    ExpressionAttributeNames: {
      "#status": "status",
      "#createdAt": "createdAt"
    },
    ExpressionAttributeValues: {
      ":statusValue": TICKET_STATUS.NEW,
      ":startOfDay": startOfDay
    }
  }

  try {
    const command = new QueryCommand(params);
    const { Items } = await docClient.send(command);

    if (Items && Items.length > 0) {
      const ticketList = Items.map(item => `ID: ${item.ticketId} - ${item.title}`).join("\n");

      const params = {
        Destination: {
          ToAddresses: [ADMIN_EMAIL]
        },
        Message: {
          Body: {
            Text: {
              Data: `Oto lista ticketów które nie zostały otworzone \n ${ticketList}`
            }
          },
          Subject: {Data: "Nie otworzone tickety z poprzednich dni"}
        },
        Source: ADMIN_EMAIL
      }
  
      await sesClient.send(new SendEmailCommand(params));
      console.log("Email wysłany");
    }
  } catch(error) {
    console.log(error);
  }
}
