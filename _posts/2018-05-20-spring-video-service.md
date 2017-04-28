---
layout: post
title: Building a video service using Spring Framework
summary: "In this article we are building a video streaming service using the Spring WebFlux,
comparing it to the Spring MVC and discovering the threading model that is used internally"
---

Some time ago a brand new WebFlux by Spring was released introducing the non-blocking reactive programming paradigm. 
One of the domains to apply this new framework is data streaming, in particular video streaming. 
In this article I'm going to build a video streaming service and describe the threading model that is being used. 

<nav>
  <h4>Table of Contents</h4>
  * TOC
  {:toc}
</nav>



Byte-range requests
-------------------

To begin with, let's investigate how the `<video>` element works and what requests it sends to
a server. For example, [w3c has an overview](https://www.w3schools.com/html/html5_video.asp) of this html element with the one embedded. 
The very first request sent to service is as follows:

```sh
GET https://www.w3schools.com/html/mov_bbb.mp4
Range: bytes=0-
...
```

Generally speaking, it is a simple http GET request. The only additional piece of data that matters is
the `Range` header. It comes from the [Range Requests specification](https://tools.ietf.org/html/rfc723) and
asks the server for a specific part of the file. The header in the previous request means that the client expects data
from position 0 in a byte representation of file till the end. 
A Range header can have a final point, e.g. `Range: bytes=50-100`.

There are two possible responses to such a kind of request:
* Status: 200 OK. It indicates that the server can't fulfil the request and is going to respond with a full
resource in one request.
* Status: 206 Partial Content. In this case server confirms its ability to respond to range requests.
Here are the headers we are interested in:

```sh
Status: 206
Accept-ranges: bytes
Content-Length: 100
Content-Range: bytes 0-99/788493
```

Lets have a closer look at them:
1. `Accept-ranges: bytes`. This one says which range unit is being  used. The most common is _bytes_
but RFC allows any other, such as seconds. It can even be [used for pagination](http://otac0n.com/blog/2012/11/21/range-header-i-choose-you.html).
2. `Content-Length: 100`. In contrast to status 200 response, which shows the full length of content,
here the stated length refers to the size of the chunk received.
3. `Content-Range: bytes 0-99/788493`. This header shows that we have bytes from 0 to 99 and these are the 100 bytes mentioned in Content-Length header.
The number 788493 after the slash tells us the full size of the file on the server. It is used by a video tag
to figure out when the content is loaded entirely.

Using this simple protocol we can specify any point in a movie to watch. 
Thanks to getting only chunks of data, users don't need to wait until an entire video is loaded,
which is particularly useful for those with slow connection and per megabyte internet pricing,
as well as for creation of a splendid user experience. 



Spring MVC
----------

The classical MVC was in use for a while and has lots and lots of different features and 
specification implementations. [After version 4.2.4](https://jira.spring.io/browse/SPR-13834) of Spring,
you can download dynamic files from a server with just a few lines of code. The byte-range support is included as well.
The following code is based on the **mvc** branch of my [sample project](https://github.com/melgenek/spring-video-service/tree/mvc)
and you can find project dependencies in _build.gradle_ file.
Here is the only piece of code you need to implement your video server:

```kotlin
@GetMapping("/videos/{name}/full")
fun getFullVideo(@PathVariable name: String): ResponseEntity<UrlResource> {
	val video = UrlResource("file:$videoLocation/$name")
	return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
			.contentType(MediaTypeFactory
					.getMediaType(video)
					.orElse(MediaType.APPLICATION_OCTET_STREAM))
			.body(video)
}
```

The purpose of the controller send files to client. Let's explore it line by line:
* **@GetMapping** obviously means that we're handling GET http requests
* The method declaration shows that it takes a name of the file as a path parameter and returns a UrlResource which is
just any resource that can be reached by url.
* Next line creates a resource from url. Resource is in essence an input stream with some additional methods.
**_$videoLocation_** variable comes from environment and is the name of a folder that holds our videos.
* Then we have **_HttpStatus_**. As mentioned earlier, we need a 206 status code
response to specify that server accepts range request and answers properly.
* The next three lines are setting media type. Browsers (except chrome) will refuse playing you video without 
a media type specified. **_MediaTypeFactory_** gives this type based on the file name.
For example, if the file name is `someVideoName.mp4`, then the MIME type `video/mp4` is returned.
If the MIME cannot be determined, the content type is specified as byte stream.
* finally, we set video resource as a body.

The only thing left to make it a full-blown video player is a bit of html :)

```html
<video autoplay="autoplay" controls>
    <source src="/videos/fish.mp4/full" type="video/mp4">
</video>
```

This section shows how simple it is to make a file server leveraging Spring.
While I'm using UrlResource, anybody can implement their own [Resource](https://github.com/spring-projects/spring-framework/blob/master/spring-core/src/main/java/org/springframework/core/io/Resource.java)
to get data from anywhere, for example, database.



MVC drawbacks
-------------

It is helpful to know how the code above works from threading perspective, and what problems we could face because of that.
The [threading model](https://docs.spring.io/spring-framework/docs/current/spring-framework-reference/web-reactive.html#webflux-concurrency-model)
of MVC is a classical one-per-user thread model. It can be easily observed with Java VisualVM.

Let's perform two requests to our server using curl (in separate terminal windows):

```sh
curl -s -o /dev/null -H "Range: bytes=0-" -D - http://localhost:8080/videos/fish.mp4/full
```

Everything works as expected and both loads finish. The threads view shows that for the load period 
two threads were occupied (green part of line) reading data from resource and writing to output stream (see [StreamUtils.copy](https://github.com/spring-projects/spring-framework/blob/master/spring-core/src/main/java/org/springframework/util/StreamUtils.java#L132)).
It is performed inside Spring's [ResourceHttpMessageConverter](https://github.com/spring-projects/spring-framework/blob/master/spring-web/src/main/java/org/springframework/http/converter/ResourceHttpMessageConverter.java#L127) 
for you.

<p style="text-align: center">
    <img width="100%"
     alt="VisualVM"
     loading="lazy"
     srcset="
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/full_file_mvc.png&w=640 640w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/full_file_mvc.png&w=768 768w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/full_file_mvc.png&w=1024 1024w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/full_file_mvc.png&w=1366 1366w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/full_file_mvc.png&w=1600 1600w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/full_file_mvc.png&w=1920 1920w,
     "
     src="/images/spring-video-service/full_file_mvc.png">
</p>

For the video streaming the main shortcoming is: server will not be able to process more users 
than number of threads it has. This means if there are 10 threads then there will be no more than 10 users.
You can easily check this behaviour by setting property `server.tomcat.max-threads=1` and calling curl twice.
The second request will be processed only after the first one ends. 
Use a big file for this experiment, several gigabytes, because local download is really fast.

Imagine a situation when your website has exclusive rights for TV series. With an average length of episode of 1 hour,
you will be able to pass the content to only 10 customers at the same time. A website with performance like this 
will never get a wide audience.



Responding with parts of data
-----------------------------

One mechanism to address the issue described in the previous section is to respond only with parts of a file. 
It is suitable only for clients which support byte range responses and html video is one of them. 
This way, threads will be used for smaller amounts of time giving opportunity to other requests to be processed.
Thanks to the [ResourceRegion](https://jira.spring.io/browse/SPR-14221) abstraction introduced in Spring version 4.3RC1
developer can now specify the range of bytes to be returned to the client.

```kotlin
@GetMapping("/videos/{name}")
fun getVideo(@PathVariable name: String, 
	     @RequestHeader headers: HttpHeaders): ResponseEntity<ResourceRegion> {
	val video = UrlResource("file:$videoLocation/$name")
	val region = resourceRegion(video, headers)
	return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
			.contentType(MediaTypeFactory
					.getMediaType(video)
					.orElse(MediaType.APPLICATION_OCTET_STREAM))
			.body(region)
}

private fun resourceRegion(video: UrlResource, headers: HttpHeaders): ResourceRegion {
	val contentLength = video.contentLength()
	val range = headers.range.firstOrNull()
	return if (range != null) {
		val start = range.getRangeStart(contentLength)
		val end = range.getRangeEnd(contentLength)
		val rangeLength = min(1 * 1024 * 1024, end - start + 1)
		ResourceRegion(video, start, rangeLength)
	} else {
		val rangeLength = min(1 * 1024 * 1024, contentLength)
		ResourceRegion(video, 0, rangeLength)
	}
}
``` 

There are several additions worth to mention:
* **_HttpHeaders_** are added to the controller to get the range header
* the returned entity is now **_ResourceRegion_**. It specifies the position in the byte representations of the file
along with the count of bytes to respond with.
*  **_resourceRegion_** method gets the range header to find the starting position. The size of chunk
can be either 1 MB, the one specified in the range header or the length of contents of file. The smallest number is taken.

Now the server takes much less time to process requests and threads have opportunity to switch to other requests.

<p style="text-align: center">
    <img width="100%"
     alt="VisualVM"
     loading="lazy"
     srcset="
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/chunk_file_mvc.png&w=640 640w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/chunk_file_mvc.png&w=768 768w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/chunk_file_mvc.png&w=1024 1024w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/chunk_file_mvc.png&w=1366 1366w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/chunk_file_mvc.png&w=1600 1600w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/chunk_file_mvc.png&w=1920 1920w,
     "
     src="/images/spring-video-service/chunk_file_mvc.png">
</p>

Spring WebFlux
--------------

Spring 5 has introduced a new paradigm of the reactive web applications, as well as the implementation of such an api
called WebFlux. The main difference is an introduction of reactive streams as a core component.

The response body of resource in MVC was represented as java.io.InputStream. 
Consequently, to get data from a file and write it to a user connection we need to have a buffer,
fill it with data from the file and only then write to the connection. 

```java
InputStream in = ??? // file stream
OutputStream out = ??? // socket connection stream

byte[] buffer = new byte[BUFFER_SIZE];
int bytesRead = in.read(buffer);
out.write(buffer, 0, bytesRead);
```  

The main deficiency of this technique is read operations are blocking and hang until the buffer is fully read.

Thanks to creation of NIO in java it is now possible to operate on byte buffers and not streams of bytes.
The response body in WebFlux is Publisher\<DataBuffer\>. DataBuffer is just an abstraction over byte buffer,
can be considered as array of bytes. [Publisher](https://github.com/reactive-streams/reactive-streams-jvm/blob/v1.0.2/README.md#1-publisher-code) 
comes from the reactive streams specification and represents a potentially infinite stream of any entities,
byte buffers in our case. The main idea of the Publisher is to work on demand. It does not produce elements
eagerly but responds to requests. If the user of this streams requests 3 items then no more than 3 items will be returned.
What's more, there items are returned in an undefined point in future so you don't need to block and wait them.
When the items arrive, a callback provided is executed.

Fortunately, WebFlux api is mostly compatible with MVC and we only need to change underlying implementation
to make things work. The [webflux](https://github.com/melgenek/spring-video-service/tree/webflux) branch of my sample repo 
shows the dependencies needed. The code is left the same as in the MVC section of this article:

```kotlin
@GetMapping("/videos/{name}/full")
fun getFullVideo(@PathVariable name: String): ResponseEntity<UrlResource> {
	val video = UrlResource("file:$videoLocation/$name")
	return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
			.contentType(MediaTypeFactory
					.getMediaType(video)
					.orElse(MediaType.APPLICATION_OCTET_STREAM))
			.body(video)
}
```

Now we're ready to repeat the experiment with only one thread available.
Set the property `reactor.ipc.netty.workerCount=1` and call curl twice:

```sh
curl -s -o /dev/null -H "Range: bytes=0-" -D - http://localhost:8080/videos/fish.mp4/full
```

This time both files are loaded at the same time without the need to wait in a queue.
I'd like to give you some intuition into how this works internally.

The server has two kinds of work done: selection and actual IO operations.
By "selection" I mean the following:
* the server has several connections, called channels
* each channel can produce events
* there is a special thread which tries to get these events. This thread is called selector. 
It performs an infinite loop inside itself (event loop). Each cycle of the loop asks the underlying OS about events 
available for each channel.
* if the selector thread gets events, it does not read or write any data. 
It just fans out these events to free workers.

Our video server is mostly interested in write operations. Let's imagine that write event pops up.
Then worker thread takes over:
* worker asks Publisher<DataBuffer> for the next byte buffer but not the whole file
* at some point in the future this buffer arrives and callback comes into play.
The buffer received is written to output stream.
* only fraction of data is allowed to be written at once. Multiple write events appear during one
client-server communication.

<p style="text-align: center">
    <img width="100%"
     alt="Reactor"
     loading="lazy"
     src="/images/spring-video-service/reactor-my-intuition.png">
</p>

The pattern described is called Reactor. It allows to handle multiple requests at the same time
using less threads by splitting the processing timeline into chunks. While it heavily relies on OS,
our program will work only on Linux. The WebFlux server blocks on Windows like the MVC one.

The default implementation used by _spring-boot-starter-webflux_ is Reactor Netty.
If no selector threads are configured then workers do both selection and actual work functions.
So they read events and handle them right away.

<p style="text-align: center">
    <img width="100%"
     alt="Reactor thread"
     loading="lazy"
     srcset="
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/reactor-thread.png&w=640 640w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/reactor-thread.png&w=768 768w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/reactor-thread.png&w=1024 1024w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/reactor-thread.png&w=1366 1366w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/reactor-thread.png&w=1600 1600w,
       https://images.weserv.nl/?url=https://melgenek.github.io/images/spring-video-service/reactor-thread.png&w=1920 1920w,
     "
     src="/images/spring-video-service/reactor-thread.png">
</p>

There is one additional bonus which comes with WebFlux: [zero-copy data transfer](https://www.ibm.com/developerworks/library/j-zerocopy/index.html).
Byte buffers, copied from file to connection, are not loaded into application memory.
All the work is being done on OS level. This feature is available using Reactor Netty (default backend) or Undertow.



Conclusion
----------

In this article I tried to build simple yet efficient video streaming service and give intuition into
how things work internally.
If you want to read more about WebFlux, reactivity and NIO, here are some useful links:
* Dave Syer's [notes on reactivity](https://spring.io/blog/2016/06/07/notes-on-reactive-programming-part-i-the-reactive-landscape)
* Sébastien Deleuze tells about [reactive types in spring](https://spring.io/blog/2016/04/19/understanding-reactive-types)
* [Threaded vs evented servers](http://www.blogjava.net/xiaomage234/archive/2016/04/05/429968.html)
* Jakob Jenkov builds his own [non-blocking web server](http://tutorials.jenkov.com/java-nio/non-blocking-server.html)
* Awesome Doug Lea's presentation about [Scalable IO in Java](http://gee.cs.oswego.edu/dl/cpjslides/nio.pdf)
* Step by step implementation of reactor using Java NIO: [part1](http://jeewanthad.blogspot.com/2013/02/reactor-pattern-explained-part-1.html), [part2](http://jeewanthad.blogspot.com/2013/03/reacter-pattern-explained-part-2.html), [part3](http://jeewanthad.blogspot.com/2013/03/reacter-pattern-explained-part-3.html)
* And a couple [more](https://tianpan.co/blog/2015-01-13-understanding-reactor-pattern-for-highly-scalable-i-o-bound-web-server) 
[articles](http://rox-xmlrpc.sourceforge.net/niotut/) [you](https://www.usenix.org/legacy/events/hotos03/tech/full_papers/vonbehren/vonbehren_html/index.html) can find useful
