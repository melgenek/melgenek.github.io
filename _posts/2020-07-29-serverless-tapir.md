---
layout: post
title: Serverless Tapir
summary: "Tapir for Scala is a great way to define http endpoints of your application. 
But the development does not end at the point of finishing the code. 
This code still has to be packaged and deployed. I will use AWS Lambda and API Gateway to narrow the gap between
Tapir source code and a complete runnable application." 
---

This blog post could start with a drawing of a tapir that has a pair of tiny angel wings and sits on a cloud.
Unfortunately, I cannot draw. But I can code. So in this article will tell how to run a Tapir program with AWS Lambda
and API Gateway.

<nav>
  <h4>Table of Contents</h4>
  * TOC
  {:toc}
</nav>



Introduction
-------------------
[Tapir](https://tapir.softwaremill.com/en/latest/index.html) is an amazing scala framework that allows defining
http endpoints as scala values. Let's look at the example that I borrowed from the official documentation: 

```scala
import sttp.tapir._
import sttp.tapir.json.circe._
import io.circe.generic.auto._

type Limit = Int
type AuthToken = String
case class BooksFromYear(genre: String, year: Int)
case class Book(title: String)

val booksListing: Endpoint[(BooksFromYear, Limit, AuthToken), String, List[Book], Nothing] = 
  endpoint
    .get
    .in(("books" / path[String]("genre") / path[Int]("year")).mapTo(BooksFromYear))
    .in(query[Limit]("limit").description("Maximum number of books to retrieve"))
    .in(header[AuthToken]("X-Auth-Token"))
    .errorOut(stringBody)
    .out(jsonBody[List[Book]])
```

This is a representation of a single endpoint with a noticeable feature that it does not have any logic attached.
The endpoint is solely a description of input parameters and outputs like response bodies.

In order to make this definition runnable, we have to use an interpreter. 
Here is an example implementation in akka-http:

```scala
import sttp.tapir.server.akkahttp._
import akka.http.scaladsl.server.Route
import scala.concurrent.Future

val booksListingRoute: Route =
    booksListing.toRoute { case (bfy: BooksFromYear, limit: Limit, at: AuthToken) =>
      Future.successful(Right(List(Book("The Sorrows of Young Werther"))))
    }
```  

The logic of the route is generic, there is no explicit use of the akka-http response codes or marshallers.
There are in fact many options of server interpreters such as play, http4s, finatra and vert.x.
However, these frameworks help only with writing the code. The next steps are most likely the docker packaging,
the definition of the kubernetes manifests and deployment scripts.

Deploying an application takes a signification amount of effort.
I want to have the code up and running quickly and easily, preferably with a single bash command. 
Tapir, AWS Lambda and [AWS CDK](https://github.com/aws/aws-cdk) will help me with this venture. The complete code can be
found in [the github repo](https://github.com/melgenek/serverless-tapir).

Implementing the interpreter
-------------------

We start with an interpreter that transform Tapir code in an AWS Lambda. We will follow these steps:
- define the logic to transform a Tapir request into the Lambda-specific request.
- then Tapir parses this request and gives me the inputs like query and path params, an input body and headers.  
- the next step is to execute the user-defined logic using these inputs as arguments.
- finally, the response from the user-defined logic is transformed back into the response that Lambda understands.

AWs Lambda itself does not know anything about http. It is just an execution environment.
We utilize the API Gateway [Http API](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html).
It parses the request and invokes our lambda as soon as the request is ready to be processed.
Http API passes the parsed request [in a predefined format](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html).
I use the `"com.amazonaws" % "aws-lambda-java-events"` to have the predefined java classes `APIGatewayV2HTTPEvent` and `APIGatewayV2HTTPResponse`
that correspond to the Http API request and response models.

As mentioned above the implementation starts mapping the `APIGatewayV2HTTPEvent` into Tapir's `ServerRequest`.

```scala
class HttpApiServerRequest(event: APIGatewayV2HTTPEvent) extends ServerRequest {
  def method: Method = Method(event.getRequestContext.getHttp.getMethod.toUpperCase)

  def protocol: String = event.getRequestContext.getHttp.getProtocol

  def uri: URI =
    new URI(s"https://${event.getRequestContext.getDomainName}${event.getRawPath}?${event.getRawQueryString}")

  def connectionInfo: ConnectionInfo = ConnectionInfo(
    local = None,
    remote = Some(InetSocketAddress.createUnresolved(event.getRequestContext.getHttp.getSourceIp, 0)),
    secure = Some(true)
  )

  lazy val headers: Seq[(String, String)] = event.getHeaders.asScala.toList
  
  def header(name: String): Option[String] = event.getHeaders.getIgnoreCase(name)
}
```

A couple of moments are worth clarification here. 

First of all, Http API passes all the headers with lower cased names, so the header lookup is done ignoring the case.

Secondly, in the `ConnectionInfo` we have only the remote client, there is no port given to the lambda. 
The communication to Http API is always secure.

The next step after defining the server request is the `DecodeInputsContext`. 
As the name suggests, this class is used by Tapir during the inputs extraction. 

```scala
class HttpApiDecodeInputsContext(event: APIGatewayV2HTTPEvent, pathConsumed: Int = 0) extends DecodeInputsContext {
  def method: Method = Method(event.getRequestContext.getHttp.getMethod.toUpperCase)

  def nextPathSegment: (Option[String], DecodeInputsContext) = {
    val path = event.getRawPath.drop(pathConsumed)
    val nextStart = path.dropWhile(_ == '/')
    val segment = nextStart.split("/", 2) match {
      case Array("") => None
      case Array(s) => Some(s)
      case Array(s, _) => Some(s)
    }
    val charactersConsumed = segment.map(_.length).getOrElse(0) + (path.length - nextStart.length)

    (segment, new HttpApiDecodeInputsContext(event, pathConsumed + charactersConsumed))
  }

  def header(name: String): List[String] = 
    event.getHeaders.getIgnoreCase(name).flatMap(_.split(",").toList).toList

  def headers: Seq[(String, String)] = event.getHeaders.asScala.toList

  def queryParameter(name: String): Seq[String] =
    event.getQueryStringParameters.getIgnoreCase(name).flatMap(_.split(",").toList).toList

  def queryParameters: QueryParams = QueryParams.fromMap(event.getQueryStringParameters.asScala.toMap)

  def bodyStream: Any =
    throw new UnsupportedOperationException("Trying to read streaming body from a non-streaming request")

  def serverRequest: ServerRequest = new HttpApiServerRequest(event)
}
```   

Multivalued headers and query params are combined with commas in Http API. So we split them back into a `List`.

The body is always passed into the lambda as a string so the whole incoming request is consumed before the lambda invocation.
That's why the body cannot be streamed, and the `bodyStream` has no implementation.

Now that we know how to map the lambda input into the input that Tapir understands, let's implement the routes.
The same way akka http has `akka.http.scaladsl.server.Route`, or http4s has `org.http4s.HttpRoutes`, we will also
have a `Route` type:

```scala
type Route = PartialFunction[APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse]
``` 

Tapir also requires a `MonadError` implementation. For akka http there is an instance of a `MonadError` based on `Future`.
That's why the akka http routes return `Futures` as results. A lambda function that runs on top of the Lambda Java runtime requires
functions to be simple blocking functions with a signature `def onEvent(event: APIGatewayV2HTTPEvent): APIGatewayV2HTTPResponse`.
I chose `Try` to be the result type of the Lambda logic. The example conversion of a function with some business logic
into a Lambda route would be:

```scala
import scala.util.{Success, Try}
import sttp.tapir.server.httpapi._  

def logic(bfy: BooksFromYear, limit: Limit, at: AuthToken): Try[Either[String, List[Book]]] = {
  Success(Right(List(Book("The Sorrows of Young Werther"))))
}
val serverEndpoint = bookListing.serverLogic((logic _).tupled)
val booksListingRoute: Route = serverEndpoint.toRoute
```

The `Route` is a partial function. If the http request matches the Tapir endpoint definition then we execute the logic for
this endpoint. If no then we try another route. This check is expressed via the `isDefinedAt` method of the partial function.
We use the `sttp.tapir.server.internal.DecodeInputs`, pass the context and let Tapir parse the request for us.

```scala
def isDefinedAt(event: APIGatewayV2HTTPEvent): Boolean = {
  DecodeInputs(e.input, new HttpApiDecodeInputsContext(event)) match {
    case _: DecodeInputsResult.Values => true
    case _: DecodeInputsResult.Failure => false
  }
}
```

When the http request matches our endpoint, it's time to run the actual application logic. The result of the `DecodeInputs`
is just a sequence of values. Thus, we map these values into scala classes, so that we get a tuple of case classes,
like `(BooksFromYear, Limit, AuthToken)` in the example above. This conversion is the responsibility of `sttp.tapir.server.internal.InputValues`.

```scala
def apply(event: APIGatewayV2HTTPEvent): APIGatewayV2HTTPResponse = {
  DecodeInputs(e.input, new HttpApiDecodeInputsContext(event)) match {
    case values: DecodeInputsResult.Values =>
      InputValues(e.input, values) match {
        case InputValuesResult.Value(params, _) => valueToResponse(params.asAny)
        case InputValuesResult.Failure(input, failure) => handleDecodeFailure(input, failure)
      }
    case DecodeInputsResult.Failure(input, failure) => handleDecodeFailure(input, failure)
  }
}
```

The next step, after the inputs are successfully parsed, is to pass these inputs into the user-defined logic. 

```scala
def valueToResponse(value: Any): APIGatewayV2HTTPResponse = {
  endpoint.logic(TryMonadError)(value.asInstanceOf[I]) match {
    case Success(Right(result)) => OutputToHttpApiResponse(ServerDefaults.StatusCodes.success, endpoint.output, result)
    case Success(Left(err)) => OutputToHttpApiResponse(ServerDefaults.StatusCodes.error, endpoint.errorOutput, err)
    case Failure(e) => OutputToHttpApiResponse(StatusCode.InternalServerError, e.getMessage)
  }
}
```

The only thing left is to map the Tapir's output to the response type that Http API understands. 
This is what `OutputToHttpApiResponse` does in the `valueToResponse` method. The implementation requires some lines of code and 
it can be found [here](https://github.com/melgenek/serverless-tapir/blob/master/lambda/src/main/scala/sttp/tapir/server/httpapi/OutputToHttpApiResponse.scala).

We put the functionality that is described in the `toRoute` function. 
The `Route` is a partial function, so we can compose multiple routes into a single one via the `orElse` method.
If none of the routes matches the request, we use the predefined `EmptyRoute` that answers with the 404 response code.
 
```scala
implicit class RichHttpApiServerEndpoint[I, E, O](endpoint: ServerEndpoint[I, E, O, Nothing, Try]) {
  def toRoute: Route = {
    // the partial function that is described above
  }
}

implicit class RichHttpApiServerEndpoints[I, E, O](serverEndpoints: List[ServerEndpoint[_, _, _, Nothing, Try]]) {
  def toRoutes: Route = {
    serverEndpoints
      .map(_.toRoute)
      .foldRight(EmptyRoute)(_ orElse _)
  }
}
```

Let's also provide an interface that has to be implemented in order to have a complete lambda. This interface requires
a list of `ServerEndpoints` and then uses these endpoints to process a request.

```scala
trait HttpApiFunction {
  val serverEndpoints: List[ServerEndpoint[_, _, _, Nothing, Try]]
  def onEvent(event: APIGatewayV2HTTPEvent): APIGatewayV2HTTPResponse = {
    serverEndpoints.toRoutes(event)
  }
}

object BookFunction extends HttpApiFunction {
  override val serverEndpoints = List(booksListingRoute)
}
```

Lambdas will have the handler that points to the `your.package.BookFunction::onEvent`. The class will be instantiated
by the Java runtime and the `onEvent` function will be invoked for every http request.


Packaging the Lambda
-------------------

I am not using lambda layers, so the Lambda function has to contain all of the dependencies.
The fat jar is packaged using the `sbt-assembly` plugin. The only interesting part of this process is the merge conflict resolution.
The reference configurations are concatenated, and some files with conflict names are discarded.

```scala
assemblyMergeStrategy in assembly := {
  case PathList("META-INF", _@_*) => MergeStrategy.discard
  case PathList(ps@_*) if ps.last endsWith "reference-overrides.conf" => MergeStrategy.concat
  case PathList(ps@_*) if ps.last endsWith "module-info.class" => MergeStrategy.discard
  case x =>
    val oldStrategy = (assemblyMergeStrategy in assembly).value
    oldStrategy(x)
}
```  

Deployment
-------------------

The interpreter is ready, it can be used to compose Tapir endpoints together into a single `Route`. The Lambda
function is also bundled into a fat jar. Everything is ready for uploading and running this jar. We can go into the AWS ui,
click a couple of buttons, create the lambda and upload the code. However, this is a manual process. The whole idea of the experiment,
that is described in this article, is to have an easy and automatic process of deploying applications.

In order to automate the lambda creation process, we will use [AWS Cloud Development Kit](https://github.com/aws/aws-cdk).
This is a tool that allows defining the AWS infrastructure in Java and transforming this definition into CloudFormation stacks.
CloudFormation then makes sure that the infrastructure is created in AWS. 

Let's create a function that receives an `HttpApiFunction` and the name of the Lambda function. This function creates a so-called `App`,
that contains all the resources. Then it synthesizes the Cloudformation template based on the code.

```scala
def deploy(httpApiFunction: HttpApiFunction, title: String): Unit = {
  val app = new awscdk.core.App()
  ...
  app.synth()
}
```

All the resources have scopes. The top-level scope is the `App`. Each app is a set of `Stacks`. Every `Stack` corresponds to a Cloudformation
stack. For us, it is enough to create a single Stack.

```scala
val stack = new Stack(app, s"$title-stack")
``` 

The first meaningful resource that we create is the lambda function. It is a lambda that is based on the Java 8 runtime.
It sets the handler method to be the `def onEvent(event: APIGatewayV2HTTPEvent): APIGatewayV2HTTPResponse` of our lambda class.
Additionally, we set the local path of the fat jar file that we have bundled. This jar is automatically uploaded by CDK into an s3 bucket.
Then this s3 object is used as the source for the lambda function.

```scala
val function = lambda.Function.Builder.create(stack, s"$title-lambda")
  .memorySize(192)
  .timeout(Duration.seconds(30))
  .functionName(title)
  .runtime(lambda.Runtime.JAVA_8)
  .handler(s"${httpApiFunction.getClass.getName.replace("$", "")}::onEvent")
  .code(Code.fromAsset("lambda/target/scala-2.13/assembly.jar"))
  .build()
```

After the lambda is present, we create the API Gateway Http API.

```scala
val api = HttpApi.Builder.create(stack, s"$title-api")
  .apiName(title)
  .build()
```

After both lambda and API are set up, we need to bind them together so that Http API passes the requests into lambda.
For this to happen, we create a Lambda integration.

```scala
val integration = LambdaProxyIntegration.Builder.create()
  .handler(function)
  .payloadFormatVersion(PayloadFormatVersion.VERSION_2_0)
  .build()
``` 

The last step is to define all the http routes and point them to the same lambda function.
Tapir's ability to transform endpoints into Open API helps us construct the routes. For every path in the Open API specification,
we create a route in the Http API.

```scala
import sttp.tapir.docs.openapi._
private def apiRoutes(httpApiFunction: HttpApiFunction, integration: LambdaProxyIntegration): List[AddRoutesOptions] = {
  val openAPI = httpApiFunction.serverEndpoints.map(_.endpoint).toOpenAPI("any name", "v1")
  openAPI.paths
    .map { case (path, pathItem) => 
    val methods =
      pathItem.get.map(_ => HttpMethod.GET) ++
        pathItem.post.map(_ => HttpMethod.POST) ++
        pathItem.delete.map(_ => HttpMethod.DELETE)
    AddRoutesOptions.builder()
      .methods(methods.toList.asJava)
      .path(path)
      .integration(integration)
      .build()
    }
    .toList
}
```

That's it. Now we pass our lambda class into the deployment function, run the `cdk deploy` command in the terminal,
and after a short time, our code is up and running in AWS. 

```scala
object Main extends App {
  HttpApiCdkServer.deploy(BookFunction, "my-bookshop")
}
```

Cdk also allows adding outputs into stacks. One of such outputs can be the url of the Http API that we deployed.

```scala
CfnOutput.Builder.create(stack, "api-url").exportName("url").value(api.getUrl).build()
```

This output is shown after the `cdk deploy` succeeds.

```sh
✅  my-bookshop-stack

Outputs:
my-bookshop-stack.apiurl = https://2qpnchfg11.execute-api.us-east-1.amazonaws.com/
```

Calling this url results in the request being handled by our lambda that is described above.

```sh
curl -v -H "X-Auth-Token: Bearer token"  https://2qpnchfg11.execute-api.us-east-1.amazonaws.com/books/novel/2020?limit=10

Result:
[
  {
    "title": "The Sorrows of Young Werther"
  }
]
```

Summary
-------------------

In this article, I showed how to run the Tapir application in Lambda and automatically deploy the code with CDK.
I believe that the use of CDK brings a lot of benefit into scala applications because it keeps the
infrastructure close to the code. The infrastructure has the same version as the code does. 
This helps us to be sure that the required infrastructure is created at the deployment time. 
In addition, CDK gives a way to deploy with a command.

The code for this article can be found in [the github repo](https://github.com/melgenek/serverless-tapir). 
